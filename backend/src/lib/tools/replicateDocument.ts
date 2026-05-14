import { downloadFile, storageKey, uploadFile } from "../storage";
import { convertedPdfKey } from "../convert";
import { buildDownloadUrl } from "../downloadTokens";
import { loadActiveVersion } from "../documentVersions";
import { resolveDocLabel } from "./shared/documentReading";
import type {
    ToolDefinition,
    ToolExecutionResult,
    DocReplicatedResult,
} from "./types";

export const replicateDocument: ToolDefinition<"replicate_document"> = {
    name: "replicate_document",
    schema: {
        type: "function",
        function: {
            name: "replicate_document",
            description:
                "Make byte-for-byte copies of an existing project document as new project documents. Use when the user wants standalone copies to edit (e.g. 'use this NDA as a template', 'give me three drafts I can adapt') without modifying the original. Pass `count` to create multiple copies in a single call rather than calling the tool repeatedly. Returns the new doc_id slugs so you can immediately call edit_document / read_document on them.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description:
                            "ID of the source document to copy (e.g. 'doc-0').",
                    },
                    count: {
                        type: "integer",
                        description:
                            "How many copies to create. Defaults to 1. Maximum 20.",
                        minimum: 1,
                        maximum: 20,
                    },
                    new_filename: {
                        type: "string",
                        description:
                            "Optional base filename. With count > 1, copies are suffixed (e.g. 'Foo (1).docx', 'Foo (2).docx'). Extension is forced to match the source.",
                    },
                },
                required: ["doc_id"],
            },
        },
    },
    // Project-only: needs both docIndex (chat-local slugs) and a projectId
    // (to attach the new copies to a project).
    availableWhen: (ctx) => ctx.docIndex != null && ctx.projectId != null,
    async execute(args, toolCallId, ctx) {
        const docIndex = ctx.docIndex!;
        const projectId = ctx.projectId!;

        const rawDocId = args.doc_id as string;
        const requestedFilename =
            typeof args.new_filename === "string" && args.new_filename.trim()
                ? args.new_filename.trim()
                : null;
        const requestedCount =
            typeof args.count === "number" && Number.isFinite(args.count)
                ? Math.max(1, Math.min(20, Math.floor(args.count)))
                : 1;
        const sourceLabel =
            resolveDocLabel(rawDocId, ctx.docStore, docIndex) ?? rawDocId;
        const sourceInfo = ctx.docStore.get(sourceLabel);
        const sourceIndexed = docIndex[sourceLabel];
        const sourceFilename = sourceInfo?.filename ?? rawDocId;

        ctx.write(
            `data: ${JSON.stringify({
                type: "doc_replicate_start",
                filename: sourceFilename,
                count: requestedCount,
            })}\n\n`,
        );

        const fail = (error: string): ToolExecutionResult => {
            ctx.write(
                `data: ${JSON.stringify({
                    type: "doc_replicated",
                    filename: sourceFilename,
                    count: requestedCount,
                    copies: [],
                    error,
                })}\n\n`,
            );
            return {
                toolResult: {
                    role: "tool",
                    tool_call_id: toolCallId,
                    content: JSON.stringify({ ok: false, error }),
                },
            };
        };

        if (!sourceInfo || !sourceIndexed) {
            return fail(`Document '${rawDocId}' not found in this project.`);
        }

        try {
            // Pull the active version once — every copy gets the same
            // starting bytes (with any accepted tracked changes rolled in),
            // no point re-fetching per copy.
            const active = await loadActiveVersion(
                sourceIndexed.document_id,
                ctx.db,
            );
            const sourcePath = active?.storage_path ?? sourceInfo.storage_path;
            const sourcePdfPath = active?.pdf_storage_path ?? null;
            const raw = await downloadFile(sourcePath);
            const pdfBytes = sourcePdfPath
                ? await downloadFile(sourcePdfPath)
                : null;
            if (!raw) {
                return fail(
                    "Could not read the source document's bytes from storage.",
                );
            }

            // Build N filenames. With count=1 keep the pre-existing
            // "(copy)" suffix; with count>1 use numbered "(1)", "(2)"
            // suffixes.
            const srcExt = sourceInfo.filename.match(/\.[^./\\]+$/)?.[0] ?? "";
            const baseStem = requestedFilename
                ? requestedFilename.replace(/\.[^./\\]+$/, "")
                : sourceInfo.filename.replace(/\.[^./\\]+$/, "");
            const filenames: string[] = [];
            for (let n = 1; n <= requestedCount; n++) {
                const suffix =
                    requestedCount === 1
                        ? requestedFilename
                            ? ""
                            : " (copy)"
                        : ` (${n})`;
                filenames.push(`${baseStem}${suffix}${srcExt}`);
            }

            // Bulk insert N documents in one round-trip.
            const docRows = filenames.map((fn) => ({
                project_id: projectId,
                user_id: ctx.userId,
                filename: fn,
                file_type: sourceInfo.file_type,
                size_bytes: raw.byteLength,
                status: "ready",
            }));
            const { data: insertedDocs, error: docErr } = await ctx.db
                .from("documents")
                .insert(docRows)
                .select("id, filename");
            if (docErr || !insertedDocs || insertedDocs.length === 0) {
                return fail(
                    `Failed to record replicated documents: ${docErr?.message ?? "unknown"}`,
                );
            }
            // Preserve the request order so each row pairs with the right
            // filename. Supabase returns inserted rows in the same order
            // as the payload.
            const newDocs = insertedDocs as {
                id: string;
                filename: string;
            }[];
            const contentType =
                sourceInfo.file_type === "pdf"
                    ? "application/pdf"
                    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

            // Parallel uploads: the doc bytes (and PDF rendition if any)
            // for every new copy.
            const uploadJobs: Promise<unknown>[] = [];
            const newKeys: string[] = [];
            const newPdfKeys: (string | null)[] = [];
            for (const d of newDocs) {
                const key = storageKey(ctx.userId, d.id, d.filename);
                newKeys.push(key);
                uploadJobs.push(uploadFile(key, raw, contentType));
                if (pdfBytes) {
                    const pdfKey = convertedPdfKey(ctx.userId, d.id);
                    newPdfKeys.push(pdfKey);
                    uploadJobs.push(
                        uploadFile(pdfKey, pdfBytes, "application/pdf"),
                    );
                } else {
                    newPdfKeys.push(null);
                }
            }
            await Promise.all(uploadJobs);

            // Bulk insert N versions in one round-trip.
            const versionRows = newDocs.map((d, idx) => ({
                document_id: d.id,
                storage_path: newKeys[idx],
                pdf_storage_path: newPdfKeys[idx],
                source: "upload",
                version_number: 1,
                display_name: d.filename,
            }));
            const { data: insertedVersions, error: verErr } = await ctx.db
                .from("document_versions")
                .insert(versionRows)
                .select("id, document_id");
            if (
                verErr ||
                !insertedVersions ||
                insertedVersions.length !== newDocs.length
            ) {
                return fail(
                    `Failed to record replicated document versions: ${verErr?.message ?? "unknown"}`,
                );
            }

            const versionByDocId = new Map<string, string>();
            for (const v of insertedVersions as {
                id: string;
                document_id: string;
            }[]) {
                versionByDocId.set(v.document_id, v.id);
            }

            // current_version_id has to be a per-row value, so a single
            // UPDATE statement can't cover all N. Fan out in parallel
            // instead of sequential awaits.
            await Promise.all(
                newDocs.map((d) =>
                    ctx.db
                        .from("documents")
                        .update({
                            current_version_id: versionByDocId.get(d.id),
                        })
                        .eq("id", d.id),
                ),
            );

            // Register every copy under a fresh doc-N slug so the model
            // can edit/read any of them in the same turn.
            const existingLabels = new Set(Object.keys(docIndex));
            let nextLabelIdx = 0;
            const copies: {
                new_filename: string;
                document_id: string;
                version_id: string;
            }[] = [];
            const toolPayloadCopies: {
                doc_id: string;
                document_id: string;
                version_id: string;
                filename: string;
                download_url: string;
            }[] = [];
            for (let idx = 0; idx < newDocs.length; idx++) {
                const d = newDocs[idx];
                const newKey = newKeys[idx];
                const versionId = versionByDocId.get(d.id);
                if (!versionId) continue;
                while (existingLabels.has(`doc-${nextLabelIdx}`))
                    nextLabelIdx++;
                const slug = `doc-${nextLabelIdx}`;
                existingLabels.add(slug);
                docIndex[slug] = {
                    document_id: d.id,
                    filename: d.filename,
                };
                ctx.docStore.set(slug, {
                    storage_path: newKey,
                    file_type: sourceInfo.file_type,
                    filename: d.filename,
                });
                copies.push({
                    new_filename: d.filename,
                    document_id: d.id,
                    version_id: versionId,
                });
                toolPayloadCopies.push({
                    doc_id: slug,
                    document_id: d.id,
                    version_id: versionId,
                    filename: d.filename,
                    download_url: buildDownloadUrl(newKey, d.filename),
                });
            }

            ctx.write(
                `data: ${JSON.stringify({
                    type: "doc_replicated",
                    filename: sourceFilename,
                    count: copies.length,
                    copies,
                })}\n\n`,
            );
            const replicated: DocReplicatedResult = {
                filename: sourceFilename,
                count: copies.length,
                copies,
            };
            return {
                toolResult: {
                    role: "tool",
                    tool_call_id: toolCallId,
                    content: JSON.stringify({
                        ok: true,
                        count: copies.length,
                        copies: toolPayloadCopies,
                    }),
                },
                sideEffects: { docsReplicated: [replicated] },
            };
        } catch (e) {
            return fail(`replicate_document failed: ${String(e)}`);
        }
    },
};
