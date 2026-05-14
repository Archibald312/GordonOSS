import type { ToolDefinition } from "./types";

export const listWorkflows: ToolDefinition<"list_workflows"> = {
    name: "list_workflows",
    schema: {
        type: "function",
        function: {
            name: "list_workflows",
            description:
                "List all workflows available to the user. Returns each workflow's ID and title. Call this when the user asks to run a workflow, apply a template, or you need to discover what workflows exist.",
            parameters: { type: "object", properties: {} },
        },
    },
    // No availability predicate: workflow tools are advertised in every chat
    // (including tabular chats with no workflowStore) to preserve current
    // behavior. The execute path handles the missing-store case gracefully.
    async execute(_args, toolCallId, ctx) {
        const list = ctx.workflowStore
            ? Array.from(ctx.workflowStore.entries()).map(([id, w]) => ({
                  id,
                  title: w.title,
              }))
            : [];
        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content: JSON.stringify(list),
            },
        };
    },
};
