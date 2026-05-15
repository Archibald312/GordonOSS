import { generateDocx } from "./shared/generateDocx";
import type { ToolDefinition, DocCreatedResult } from "./types";

export const generateDocxTool: ToolDefinition<"generate_docx"> = {
    name: "generate_docx",
    schema: {
        type: "function",
        function: {
            name: "generate_docx",
            description:
                "Generate a Word (.docx) document from structured content. Use this when the user asks you to draft, create, or produce a finance document (e.g. memo, IC paper, term sheet, diligence report, contract). Returns a download URL for the generated file.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description:
                            "Document title (used as filename and heading)",
                    },
                    landscape: {
                        type: "boolean",
                        description:
                            "Set to true for landscape page orientation. Default is portrait.",
                    },
                    sections: {
                        type: "array",
                        description:
                            "List of document sections. Each section may contain a heading, prose content, or a table.",
                        items: {
                            type: "object",
                            properties: {
                                heading: {
                                    type: "string",
                                    description: "Optional section heading",
                                },
                                level: {
                                    type: "integer",
                                    description: "Heading level: 1, 2, or 3",
                                },
                                content: {
                                    type: "string",
                                    description:
                                        "Prose text content (paragraphs separated by double newlines)",
                                },
                                pageBreak: {
                                    type: "boolean",
                                    description:
                                        "Set to true to start this section on a new page. Use for contract signature pages.",
                                },
                                table: {
                                    type: "object",
                                    description:
                                        "Optional table to render in this section",
                                    properties: {
                                        headers: {
                                            type: "array",
                                            items: { type: "string" },
                                            description: "Column header labels",
                                        },
                                        rows: {
                                            type: "array",
                                            items: {
                                                type: "array",
                                                items: { type: "string" },
                                            },
                                            description:
                                                "Array of rows, each row is an array of cell strings matching the headers order",
                                        },
                                    },
                                    required: ["headers", "rows"],
                                },
                            },
                        },
                    },
                },
                required: ["title", "sections"],
            },
        },
    },
    async execute(args, toolCallId, ctx) {
        const title = args.title as string;
        const landscape = !!args.landscape;
        console.log(
            `[generate_docx] title="${title}" landscape=${landscape} args.landscape=${args.landscape}`,
        );
        const previewFilename = `${
            title
                .replace(/[^a-zA-Z0-9 _-]/g, "")
                .trim()
                .slice(0, 64) || "document"
        }.docx`;
        ctx.write(
            `data: ${JSON.stringify({ type: "doc_created_start", filename: previewFilename })}\n\n`,
        );
        const result = await generateDocx(
            title,
            args.sections as unknown[],
            ctx.userId,
            ctx.db,
            { landscape, projectId: ctx.projectId ?? null },
        );

        const docsCreated: DocCreatedResult[] = [];
        let newDocLabel: string | null = null;

        if ("filename" in result && "download_url" in result) {
            const dlFilename = result.filename as string;
            const dlUrl = result.download_url as string;
            const documentId = (result as { document_id?: string }).document_id;
            const versionId = (result as { version_id?: string }).version_id;
            const versionNumber =
                (result as { version_number?: number }).version_number ?? null;
            const storagePath = (result as { storage_path?: string })
                .storage_path;

            // Register the generated doc in the chat context so
            // edit_document (and read_document / find_in_document)
            // can act on it within the same assistant turn. New label
            // is the next free `doc-N` index. Subsequent turns pick
            // it up via the normal attachment/project doc query.
            if (documentId && storagePath && ctx.docIndex) {
                const existingLabels = new Set(Object.keys(ctx.docIndex));
                let i = 0;
                while (existingLabels.has(`doc-${i}`)) i++;
                newDocLabel = `doc-${i}`;
                ctx.docIndex[newDocLabel] = {
                    document_id: documentId,
                    filename: dlFilename,
                };
                ctx.docStore.set(newDocLabel, {
                    storage_path: storagePath,
                    file_type: "docx",
                    filename: dlFilename,
                });
            }

            ctx.write(
                `data: ${JSON.stringify({
                    type: "doc_created",
                    filename: dlFilename,
                    download_url: dlUrl,
                    document_id: documentId,
                    version_id: versionId,
                    version_number: versionNumber,
                })}\n\n`,
            );
            docsCreated.push({
                filename: dlFilename,
                download_url: dlUrl,
                document_id: documentId,
                version_id: versionId,
                version_number: versionNumber,
            });
        } else {
            ctx.write(
                `data: ${JSON.stringify({ type: "doc_created", filename: previewFilename, download_url: "" })}\n\n`,
            );
        }
        // Surface the chat-local doc label in the tool result so the
        // model can pass it as `doc_id` to edit_document / read_document
        // / find_in_document in the same turn. Without this the model
        // only sees the DB UUID, which isn't valid as a doc_id anchor.
        const { download_url, storage_path, ...safeToolResult } =
            result as Record<string, unknown>;
        void download_url;
        void storage_path;
        const toolResultPayload = newDocLabel
            ? {
                  ...safeToolResult,
                  doc_id: newDocLabel,
                  next_required_action: `Before writing your final response, call read_document with doc_id "${newDocLabel}". Describe and cite the generated document using doc_id "${newDocLabel}", not the source/template document.`,
              }
            : safeToolResult;
        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content: JSON.stringify(toolResultPayload),
            },
            sideEffects: docsCreated.length ? { docsCreated } : undefined,
        };
    },
};
