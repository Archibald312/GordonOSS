import type { ToolDefinition } from "./types";

export const listDocuments: ToolDefinition<"list_documents"> = {
    name: "list_documents",
    schema: {
        type: "function",
        function: {
            name: "list_documents",
            description:
                "List all documents available in the project. Returns each document's ID, filename, and file type. Call this to discover what documents are available before deciding which ones to read.",
            parameters: { type: "object", properties: {} },
        },
    },
    // Project chats only — general chats already attach docs inline and
    // don't need a discovery step.
    availableWhen: (ctx) => ctx.projectId != null,
    async execute(_args, toolCallId, ctx) {
        const list = Array.from(ctx.docStore.entries()).map(
            ([doc_id, info]) => ({
                doc_id,
                filename: info.filename,
                file_type: info.file_type,
            }),
        );
        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content: JSON.stringify(list),
            },
        };
    },
};
