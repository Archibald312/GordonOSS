import type { OpenAIToolSchema, UserApiKeys } from "../llm/types";
import type { createServerSupabase } from "../supabase";
import type {
    DocStore,
    DocIndex,
    WorkflowStore,
    TabularCellStore,
} from "../chatTools";

export type EditAnnotation = {
    kind: "edit";
    edit_id: string;
    document_id: string;
    version_id: string;
    version_number?: number | null;
    change_id: string;
    del_w_id?: string;
    ins_w_id?: string;
    deleted_text: string;
    inserted_text: string;
    context_before: string;
    context_after: string;
    reason?: string;
    status: "pending" | "accepted" | "rejected";
};

export type DocEditedResult = {
    filename: string;
    document_id: string;
    version_id: string;
    version_number: number | null;
    download_url: string;
    annotations: EditAnnotation[];
};

export type DocCreatedResult = {
    filename: string;
    download_url: string;
    document_id?: string;
    version_id?: string;
    version_number?: number | null;
};

export type DocReplicatedResult = {
    /** Filename of the source document being copied. */
    filename: string;
    /** How many copies were produced in this single tool call. */
    count: number;
    /** One entry per new copy. */
    copies: {
        new_filename: string;
        document_id: string;
        version_id: string;
    }[];
};

export type TurnEditState = Map<
    string,
    { versionId: string; versionNumber: number; storagePath: string }
>;

export interface ToolContext {
    userId: string;
    userEmail?: string;
    db: ReturnType<typeof createServerSupabase>;
    docStore: DocStore;
    docIndex?: DocIndex;
    workflowStore?: WorkflowStore;
    tabularStore?: TabularCellStore;
    turnEditState?: TurnEditState;
    projectId?: string | null;
    write: (s: string) => void;
    apiKeys?: UserApiKeys;
}

export interface ToolSideEffects {
    docsRead?: { filename: string; document_id?: string }[];
    docsFound?: { filename: string; query: string; total_matches: number }[];
    docsCreated?: DocCreatedResult[];
    docsReplicated?: DocReplicatedResult[];
    workflowsApplied?: { workflow_id: string; title: string }[];
    docsEdited?: DocEditedResult[];
}

export interface ToolExecutionResult {
    toolResult: { role: "tool"; tool_call_id: string; content: string };
    sideEffects?: ToolSideEffects;
}

export interface ToolDefinition<TName extends string = string> {
    readonly name: TName;
    readonly schema: OpenAIToolSchema;
    /**
     * Returning false hides the tool from the model for this turn. Use this
     * when a tool depends on context that may be absent (e.g. docIndex,
     * tabularStore, projectId). The dispatcher will refuse to execute a tool
     * whose predicate is false even if the model calls it anyway.
     */
    readonly availableWhen?: (ctx: ToolContext) => boolean;
    execute(
        args: Record<string, unknown>,
        toolCallId: string,
        ctx: ToolContext,
    ): Promise<ToolExecutionResult>;
}
