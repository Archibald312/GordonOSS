import { runEditDocument } from "./shared/runEditDocument";
import { resolveDocLabel } from "./shared/documentReading";
import type { EditInput } from "../docxTrackedChanges";
import type { ToolDefinition, DocEditedResult } from "./types";

export const editDocument: ToolDefinition<"edit_document"> = {
    name: "edit_document",
    schema: {
        type: "function",
        function: {
            name: "edit_document",
            description:
                "Propose edits to a user-attached .docx as tracked changes. Each edit is a precise, minimal substitution of specific words/characters, NOT a whole-line or paragraph replacement. Use read_document first. Anchor each edit with short before/after context so it can be located unambiguously. Returns per-edit annotations the UI will render as Accept/Reject cards and a download link to the edited document.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description: "Document slug (e.g. 'doc-0').",
                    },
                    edits: {
                        type: "array",
                        description: "List of precise substitutions.",
                        items: {
                            type: "object",
                            properties: {
                                find: {
                                    type: "string",
                                    description:
                                        "Exact substring to replace (keep it as short as possible — ideally just the words/chars being changed).",
                                },
                                replace: {
                                    type: "string",
                                    description:
                                        "Replacement text. Empty string = pure deletion.",
                                },
                                context_before: {
                                    type: "string",
                                    description:
                                        "~40 chars immediately preceding `find`, used to disambiguate.",
                                },
                                context_after: {
                                    type: "string",
                                    description:
                                        "~40 chars immediately following `find`.",
                                },
                                reason: {
                                    type: "string",
                                    description:
                                        "Short explanation shown to the user on the card.",
                                },
                            },
                            required: [
                                "find",
                                "replace",
                                "context_before",
                                "context_after",
                            ],
                        },
                    },
                },
                required: ["doc_id", "edits"],
            },
        },
    },
    availableWhen: (ctx) => ctx.docIndex != null,
    async execute(args, toolCallId, ctx) {
        // availableWhen guarantees docIndex is set.
        const docIndex = ctx.docIndex!;

        const rawDocId = args.doc_id as string;
        const editsRaw = args.edits as unknown[] | undefined;
        const docId =
            resolveDocLabel(rawDocId, ctx.docStore, docIndex) ?? rawDocId;
        const docInfo = ctx.docStore.get(docId);
        const indexed = docIndex[docId];

        const emitEditError = (
            filename: string,
            documentId: string,
            error: string,
        ) => {
            // Surface the failure as a failed "Edited" block in the UI
            // (start → done-with-error) so it matches the shape the
            // success/late-failure paths already use.
            ctx.write(
                `data: ${JSON.stringify({
                    type: "doc_edited_start",
                    filename,
                })}\n\n`,
            );
            ctx.write(
                `data: ${JSON.stringify({
                    type: "doc_edited",
                    filename,
                    document_id: documentId,
                    version_id: "",
                    download_url: "",
                    annotations: [],
                    error,
                })}\n\n`,
            );
        };

        const replyError = (err: string) => ({
            toolResult: {
                role: "tool" as const,
                tool_call_id: toolCallId,
                content: JSON.stringify({ error: err }),
            },
        });

        if (!docInfo || !indexed) {
            const err = `Document '${docId}' not found in this chat's attachments.`;
            emitEditError(docId, indexed?.document_id ?? "", err);
            return replyError(err);
        }
        if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
            const err = "edits array is required and must not be empty.";
            emitEditError(docInfo.filename, indexed.document_id, err);
            return replyError(err);
        }
        if (docInfo.file_type !== "docx") {
            const err = "edit_document only supports .docx files.";
            emitEditError(docInfo.filename, indexed.document_id, err);
            return replyError(err);
        }

        ctx.write(
            `data: ${JSON.stringify({
                type: "doc_edited_start",
                filename: docInfo.filename,
            })}\n\n`,
        );
        const edits: EditInput[] = (editsRaw as Record<string, unknown>[]).map(
            (e) => ({
                find: String(e.find ?? ""),
                replace: String(e.replace ?? ""),
                context_before: String(e.context_before ?? ""),
                context_after: String(e.context_after ?? ""),
                reason: e.reason ? String(e.reason) : undefined,
            }),
        );
        const reuseVersion = ctx.turnEditState?.get(indexed.document_id);
        const result = await runEditDocument({
            documentId: indexed.document_id,
            userId: ctx.userId,
            edits,
            db: ctx.db,
            reuseVersion,
        });

        if (!result.ok) {
            ctx.write(
                `data: ${JSON.stringify({
                    type: "doc_edited",
                    filename: docInfo.filename,
                    document_id: indexed.document_id,
                    version_id: "",
                    download_url: "",
                    annotations: [],
                    error: result.error,
                })}\n\n`,
            );
            return {
                toolResult: {
                    role: "tool",
                    tool_call_id: toolCallId,
                    content: JSON.stringify({
                        ok: false,
                        error: result.error,
                    }),
                },
            };
        }

        ctx.turnEditState?.set(indexed.document_id, {
            versionId: result.version_id,
            versionNumber: result.version_number,
            storagePath: result.storage_path,
        });
        // Keep the chat-local doc label pointed at the latest edited
        // version so any follow-up read_document call in the same
        // assistant turn reads and cites the same bytes.
        if (docIndex[docId]) {
            docIndex[docId] = {
                ...docIndex[docId],
                version_id: result.version_id,
                version_number: result.version_number,
            };
        }
        const currentDocStore = ctx.docStore.get(docId);
        if (currentDocStore) {
            ctx.docStore.set(docId, {
                ...currentDocStore,
                storage_path: result.storage_path,
            });
        }
        const payload: DocEditedResult = {
            filename: docInfo.filename,
            document_id: indexed.document_id,
            version_id: result.version_id,
            version_number: result.version_number,
            download_url: result.download_url,
            annotations: result.annotations,
        };
        ctx.write(
            `data: ${JSON.stringify({
                type: "doc_edited",
                ...payload,
            })}\n\n`,
        );
        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content: JSON.stringify({
                    ok: true,
                    doc_id: docId,
                    document_id: indexed.document_id,
                    version_id: result.version_id,
                    version_number: result.version_number,
                    applied: result.annotations.length,
                    errors: result.errors,
                }),
            },
            sideEffects: { docsEdited: [payload] },
        };
    },
};
