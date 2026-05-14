import {
    citationReminder,
    readDocumentContent,
    resolveDocLabel,
} from "./shared/documentReading";
import type { ToolDefinition } from "./types";

export const fetchDocuments: ToolDefinition<"fetch_documents"> = {
    name: "fetch_documents",
    schema: {
        type: "function",
        function: {
            name: "fetch_documents",
            description:
                "Read the full text content of multiple documents in a single call. Use this instead of calling read_document repeatedly when you need to read several documents at once.",
            parameters: {
                type: "object",
                properties: {
                    doc_ids: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Array of document IDs to read (e.g. ['doc-0', 'doc-2'])",
                    },
                },
                required: ["doc_ids"],
            },
        },
    },
    availableWhen: (ctx) => ctx.projectId != null,
    async execute(args, toolCallId, ctx) {
        const rawDocIds = (args.doc_ids as string[]) ?? [];
        const docIds = rawDocIds.map(
            (id) => resolveDocLabel(id, ctx.docStore, ctx.docIndex) ?? id,
        );
        const docsRead: { filename: string; document_id?: string }[] = [];
        const parts: string[] = [];
        for (const docId of docIds) {
            const content = await readDocumentContent(
                docId,
                ctx.docStore,
                ctx.write,
                ctx.docIndex,
                ctx.db,
            );
            const filename = ctx.docStore.get(docId)?.filename ?? docId;
            parts.push(
                `--- ${filename} (${docId}) ---\n${citationReminder(docId, filename)}\n\n${content}`,
            );
            if (ctx.docStore.get(docId)) {
                const documentId = ctx.docIndex?.[docId]?.document_id;
                docsRead.push({ filename, document_id: documentId });
            }
        }
        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content: parts.join("\n\n"),
            },
            sideEffects: { docsRead },
        };
    },
};
