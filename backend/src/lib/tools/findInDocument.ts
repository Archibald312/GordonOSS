import {
    findInDocumentContent,
    resolveDocLabel,
} from "./shared/documentReading";
import type { ToolDefinition } from "./types";

export const findInDocument: ToolDefinition<"find_in_document"> = {
    name: "find_in_document",
    schema: {
        type: "function",
        function: {
            name: "find_in_document",
            description:
                "Search for specific strings inside a document — a Ctrl+F equivalent. Returns each match with surrounding context so you can locate and quote the exact text without reading the whole document. Matching is case-insensitive and whitespace-tolerant. Use this for targeted lookups (e.g. finding a clause title, party name, or a specific phrase) rather than reading the whole document.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description:
                            "The document ID to search (e.g. 'doc-0').",
                    },
                    query: {
                        type: "string",
                        description:
                            "The string to search for. Matching is case-insensitive and collapses runs of whitespace, so 'Section 4.2' matches 'section   4.2'.",
                    },
                    max_results: {
                        type: "integer",
                        description:
                            "Maximum number of matches to return (default 20). Use a smaller value for common terms.",
                    },
                    context_chars: {
                        type: "integer",
                        description:
                            "Characters of surrounding context to include on each side of a match (default 80).",
                    },
                },
                required: ["doc_id", "query"],
            },
        },
    },
    async execute(args, toolCallId, ctx) {
        const rawDocId = args.doc_id as string;
        const docId =
            resolveDocLabel(rawDocId, ctx.docStore, ctx.docIndex) ?? rawDocId;
        const query = (args.query as string) ?? "";
        const maxResults =
            typeof args.max_results === "number" ? args.max_results : undefined;
        const contextChars =
            typeof args.context_chars === "number"
                ? args.context_chars
                : undefined;
        const content = await findInDocumentContent({
            docLabel: docId,
            query,
            maxResults,
            contextChars,
            docStore: ctx.docStore,
            write: ctx.write,
            docIndex: ctx.docIndex,
            db: ctx.db,
        });

        const filename = ctx.docStore.get(docId)?.filename;
        const docsFound: {
            filename: string;
            query: string;
            total_matches: number;
        }[] = [];
        if (filename) {
            let totalMatches = 0;
            try {
                const parsed = JSON.parse(content) as {
                    total_matches?: number;
                };
                totalMatches = parsed.total_matches ?? 0;
            } catch {
                /* ignore — still record the find attempt */
            }
            docsFound.push({ filename, query, total_matches: totalMatches });
        }

        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content,
            },
            sideEffects: docsFound.length ? { docsFound } : undefined,
        };
    },
};
