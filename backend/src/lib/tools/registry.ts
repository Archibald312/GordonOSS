import type { OpenAIToolSchema } from "../llm/types";
import type { ToolCall } from "../chatTools";
import type {
    ToolContext,
    ToolDefinition,
    ToolExecutionResult,
    ToolSideEffects,
} from "./types";
import { listDocuments } from "./listDocuments";
import { fetchDocuments } from "./fetchDocuments";
import { listWorkflows } from "./listWorkflows";
import { readWorkflow } from "./readWorkflow";
import { readDocument } from "./readDocument";
import { findInDocument } from "./findInDocument";
import { readTableCells } from "./readTableCells";
import { generateDocxTool } from "./generateDocx";
import { editDocument } from "./editDocument";
import { replicateDocument } from "./replicateDocument";

// Tools are added here in the order they should be advertised to the model.
// Order matters: some providers weight tool selection by position.
const TOOL_REGISTRY = [
    readDocument,
    findInDocument,
    editDocument,
    generateDocxTool,
    replicateDocument,
    listDocuments,
    fetchDocuments,
    listWorkflows,
    readWorkflow,
    readTableCells,
] as const satisfies readonly ToolDefinition[];

export type ToolName = (typeof TOOL_REGISTRY)[number]["name"];

const TOOLS_BY_NAME: ReadonlyMap<ToolName, ToolDefinition> = new Map(
    TOOL_REGISTRY.map((t) => [t.name, t]),
);

export { TOOL_REGISTRY };

/**
 * Look up a tool by name, respecting its availability predicate. Returns
 * undefined if the name isn't registered or the tool isn't usable in this
 * context — callers should fall back to legacy dispatch in that case
 * (during the chatTools.ts migration).
 */
export function getAvailableTool(
    name: string,
    ctx: ToolContext,
): ToolDefinition | undefined {
    const tool = TOOLS_BY_NAME.get(name as ToolName);
    if (!tool) return undefined;
    if (tool.availableWhen && !tool.availableWhen(ctx)) return undefined;
    return tool;
}

/**
 * Return the schemas for tools that are usable given the current context.
 * Mirrors today's behavior where TOOLS / PROJECT_EXTRA_TOOLS / TABULAR_TOOLS /
 * WORKFLOW_TOOLS were composed by the caller; the predicate lives on each
 * ToolDefinition now so composition is a single pass.
 */
export function buildAvailableToolSchemas(ctx: ToolContext): OpenAIToolSchema[] {
    return TOOL_REGISTRY.filter(
        (t) => !t.availableWhen || t.availableWhen(ctx),
    ).map((t) => t.schema);
}

/**
 * Run a batch of tool calls and aggregate their side effects. This replaces
 * the if/else chain in the old runToolCalls — each tool owns its own
 * dispatch logic and reports a uniform ToolExecutionResult.
 */
export async function runToolCalls(
    toolCalls: ToolCall[],
    ctx: ToolContext,
): Promise<{
    toolResults: ToolExecutionResult["toolResult"][];
    docsRead: NonNullable<ToolSideEffects["docsRead"]>;
    docsFound: NonNullable<ToolSideEffects["docsFound"]>;
    docsCreated: NonNullable<ToolSideEffects["docsCreated"]>;
    docsReplicated: NonNullable<ToolSideEffects["docsReplicated"]>;
    workflowsApplied: NonNullable<ToolSideEffects["workflowsApplied"]>;
    docsEdited: NonNullable<ToolSideEffects["docsEdited"]>;
}> {
    const toolResults: ToolExecutionResult["toolResult"][] = [];
    const docsRead: NonNullable<ToolSideEffects["docsRead"]> = [];
    const docsFound: NonNullable<ToolSideEffects["docsFound"]> = [];
    const docsCreated: NonNullable<ToolSideEffects["docsCreated"]> = [];
    const docsReplicated: NonNullable<ToolSideEffects["docsReplicated"]> = [];
    const workflowsApplied: NonNullable<ToolSideEffects["workflowsApplied"]> = [];
    const docsEdited: NonNullable<ToolSideEffects["docsEdited"]> = [];

    for (const tc of toolCalls) {
        const tool = TOOLS_BY_NAME.get(tc.function.name as ToolName);
        if (!tool) continue;
        if (tool.availableWhen && !tool.availableWhen(ctx)) continue;

        let args: Record<string, unknown> = {};
        try {
            args = JSON.parse(tc.function.arguments || "{}");
        } catch {
            /* ignore — tool sees empty args */
        }

        const result = await tool.execute(args, tc.id, ctx);
        toolResults.push(result.toolResult);

        const s = result.sideEffects;
        if (!s) continue;
        if (s.docsRead) docsRead.push(...s.docsRead);
        if (s.docsFound) docsFound.push(...s.docsFound);
        if (s.docsCreated) docsCreated.push(...s.docsCreated);
        if (s.docsReplicated) docsReplicated.push(...s.docsReplicated);
        if (s.workflowsApplied) workflowsApplied.push(...s.workflowsApplied);
        if (s.docsEdited) docsEdited.push(...s.docsEdited);
    }

    return {
        toolResults,
        docsRead,
        docsFound,
        docsCreated,
        docsReplicated,
        workflowsApplied,
        docsEdited,
    };
}
