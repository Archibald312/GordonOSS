import {
    citationReminder,
    readDocumentContent,
    resolveDocLabel,
} from "./shared/documentReading";
import type { ToolDefinition } from "./types";

export const readDocument: ToolDefinition<"read_document"> = {
    name: "read_document",
    schema: {
        type: "function",
        function: {
            name: "read_document",
            description:
                "Read the full text content of a document attached by the user. Always call this before answering questions about, summarising, or citing from a document.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description:
                            "The document ID to read (e.g. 'doc-0', 'doc-1')",
                    },
                },
                required: ["doc_id"],
            },
        },
    },
    async execute(args, toolCallId, ctx) {
        const rawDocId = args.doc_id as string;
        const docId =
            resolveDocLabel(rawDocId, ctx.docStore, ctx.docIndex) ?? rawDocId;
        const content = await readDocumentContent(
            docId,
            ctx.docStore,
            ctx.write,
            ctx.docIndex,
            ctx.db,
        );
        const filename = ctx.docStore.get(docId)?.filename;
        const documentId = ctx.docIndex?.[docId]?.document_id;
        const docsRead = filename
            ? [{ filename, document_id: documentId }]
            : [];
        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content: filename
                    ? `${citationReminder(docId, filename)}\n\n${content}`
                    : content,
            },
            sideEffects: docsRead.length ? { docsRead } : undefined,
        };
    },
};
