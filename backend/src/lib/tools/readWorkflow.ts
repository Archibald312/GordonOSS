import type { ToolDefinition } from "./types";

export const readWorkflow: ToolDefinition<"read_workflow"> = {
    name: "read_workflow",
    schema: {
        type: "function",
        function: {
            name: "read_workflow",
            description:
                "Read the full instructions (prompt) of a workflow by its ID. Call this after list_workflows to load a specific workflow's prompt, then follow those instructions.",
            parameters: {
                type: "object",
                properties: {
                    workflow_id: {
                        type: "string",
                        description: "The workflow ID to read",
                    },
                },
                required: ["workflow_id"],
            },
        },
    },
    async execute(args, toolCallId, ctx) {
        const wfId = args.workflow_id as string;
        const wf = ctx.workflowStore?.get(wfId);
        const workflowsApplied: { workflow_id: string; title: string }[] = [];
        if (wf) {
            ctx.write(
                `data: ${JSON.stringify({ type: "workflow_applied", workflow_id: wfId, title: wf.title })}\n\n`,
            );
            workflowsApplied.push({ workflow_id: wfId, title: wf.title });
        }
        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content: wf ? wf.prompt_md : `Workflow '${wfId}' not found.`,
            },
            sideEffects: workflowsApplied.length ? { workflowsApplied } : undefined,
        };
    },
};
