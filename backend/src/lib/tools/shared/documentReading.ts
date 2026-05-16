import path from "path";
import { downloadFile } from "../../storage";
import { extractDocxBodyText } from "../../docxTrackedChanges";
import { loadActiveVersion } from "../../documentVersions";
import { extractXlsx, flattenXlsxForLLM } from "../../extractors/xlsx";
import { extractCsv } from "../../extractors/csv";
import type { createServerSupabase } from "../../supabase";
import type { DocStore, DocIndex } from "../../chatTools";

const STANDARD_FONT_DATA_URL = (() => {
    try {
        const pkgPath = require.resolve("pdfjs-dist/package.json");
        return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
    } catch {
        return undefined;
    }
})();

export function resolveDoc(rawId: string, docIndex: DocIndex) {
    return docIndex[rawId];
}

/**
 * Resolve whatever identifier the model passed (`doc-N` slug, filename, or
 * document UUID) back to a chat-local doc label. Generated docs surface in
 * tool results with both `doc_id` (slug) and `document_id` (UUID), so the
 * model often picks the wrong one — without this fallback `read_document`
 * silently returns "not found" and the model gives up and re-generates.
 */
export function resolveDocLabel(
    rawId: string,
    docStore: DocStore,
    docIndex?: DocIndex,
): string | null {
    if (docStore.has(rawId)) return rawId;
    for (const [label, info] of docStore.entries()) {
        if (info.filename === rawId) return label;
    }
    if (docIndex) {
        for (const [label, info] of Object.entries(docIndex)) {
            if (info.document_id === rawId) return label;
        }
    }
    return null;
}

export function citationReminder(
    docLabel: string,
    filename: string,
    fileType?: string,
): string {
    const isSpreadsheet = fileType === "xlsx" || fileType === "csv";
    const lines = [
        `[Citation requirement for ${docLabel} ("${filename}")]:`,
        `If your final answer makes any factual claim from this document, include inline [N] markers and append a final <CITATIONS> JSON block.`,
        `Every citation entry for this document MUST use "doc_id": "${docLabel}".`,
    ];
    if (isSpreadsheet) {
        lines.push(
            `This is a spreadsheet. For each citation, set "page" to the sheet+cell coordinate (e.g. "Income Statement!B12") and "quote" to the cell's exact value as shown in the [Sheet!Addr] tags.`,
            `Use this exact citation object shape: {"ref": 1, "doc_id": "${docLabel}", "page": "Income Statement!B12", "quote": "4200000"}.`,
        );
    } else {
        lines.push(
            `Use this exact citation object shape: {"ref": 1, "doc_id": "${docLabel}", "page": 1, "quote": "exact verbatim text from the document"}.`,
        );
    }
    lines.push(
        `Do not use "marker" or "text" keys in the citation block; use "ref" and "quote".`,
    );
    return lines.join("\n");
}

export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({
            data: new Uint8Array(buf),
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
        }).promise;
        const parts: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            parts.push(
                `[Page ${i}]\n${textContent.items.map((it) => it.str ?? "").join(" ")}`,
            );
        }
        return parts.join("\n\n");
    } catch {
        return "";
    }
}

/**
 * Resolve the current .docx bytes for a document, preferring the active
 * tracked-changes version if one exists, else the original upload.
 */
export async function loadCurrentVersionBytes(
    documentId: string,
    db: ReturnType<typeof createServerSupabase>,
): Promise<{ bytes: Buffer; storage_path: string } | null> {
    const active = await loadActiveVersion(documentId, db);
    if (!active) return null;
    const raw = await downloadFile(active.storage_path);
    if (!raw) return null;
    return { bytes: Buffer.from(raw), storage_path: active.storage_path };
}

export async function readDocumentContent(
    docLabel: string,
    docStore: DocStore,
    write: (s: string) => void,
    docIndex?: DocIndex,
    db?: ReturnType<typeof createServerSupabase>,
    opts?: { emitEvents?: boolean },
): Promise<string> {
    const emitEvents = opts?.emitEvents ?? true;
    console.log(`[read_document] called with docLabel="${docLabel}"`);
    const docInfo = docStore.get(docLabel);
    if (!docInfo) {
        console.log(
            `[read_document] MISS — docLabel "${docLabel}" not in docStore. Known labels:`,
            Array.from(docStore.keys()),
        );
        return "Document not found.";
    }
    console.log(
        `[read_document] docInfo: filename="${docInfo.filename}", file_type="${docInfo.file_type}", storage_path="${docInfo.storage_path}"`,
    );

    const documentId = docIndex?.[docLabel]?.document_id;
    const emitDocRead = () => {
        if (!emitEvents) return;
        write(
            `data: ${JSON.stringify({
                type: "doc_read",
                filename: docInfo.filename,
                document_id: documentId,
            })}\n\n`,
        );
    };
    if (emitEvents)
        write(
            `data: ${JSON.stringify({
                type: "doc_read_start",
                filename: docInfo.filename,
                document_id: documentId,
            })}\n\n`,
        );
    try {
        // Prefer the current tracked-changes version (if any) so read_document
        // reflects accepted/pending edits rather than the original upload.
        let raw: ArrayBuffer | null = null;
        let sourcePath = docInfo.storage_path;
        if (documentId && db) {
            const current = await loadCurrentVersionBytes(documentId, db);
            if (current) {
                raw = current.bytes.buffer.slice(
                    current.bytes.byteOffset,
                    current.bytes.byteOffset + current.bytes.byteLength,
                ) as ArrayBuffer;
                sourcePath = current.storage_path;
                console.log(
                    `[read_document] using current version path="${sourcePath}" (bytes=${raw.byteLength})`,
                );
            } else {
                console.log(
                    `[read_document] loadCurrentVersionBytes returned null for documentId="${documentId}", falling back to original storage_path`,
                );
            }
        }
        if (!raw) {
            raw = await downloadFile(docInfo.storage_path);
            if (raw) {
                console.log(
                    `[read_document] fallback download from storage_path="${docInfo.storage_path}" (bytes=${raw.byteLength})`,
                );
            }
        }
        if (!raw) {
            console.log(
                `[read_document] FAILED to download any bytes for docLabel="${docLabel}" (tried path="${sourcePath}")`,
            );
            emitDocRead();
            return "Document could not be read.";
        }
        // Log the first 8 bytes so we can identify real file format regardless
        // of the declared file_type. Valid .docx starts with "PK\x03\x04"
        // (zip). Legacy .doc starts with "\xD0\xCF\x11\xE0" (OLE/CFB).
        // %PDF-1 is a PDF even if mislabeled. Truncated uploads show as all-zero.
        {
            const head = Buffer.from(raw).subarray(0, 8);
            const hex = head.toString("hex");
            const ascii = head.toString("binary").replace(/[^\x20-\x7e]/g, ".");
            console.log(
                `[read_document] magic bytes hex=${hex} ascii="${ascii}" for filename="${docInfo.filename}"`,
            );
        }
        let text: string;
        if (docInfo.file_type === "xlsx") {
            try {
                const extract = await extractXlsx(Buffer.from(raw));
                text = flattenXlsxForLLM(extract);
                console.log(
                    `[read_document] xlsx extract length=${text.length} sheets=${extract.sheets.length} for filename="${docInfo.filename}"`,
                );
            } catch (err) {
                console.log(`[read_document] xlsx extract failed:`, err);
                text = "";
            }
        } else if (docInfo.file_type === "csv") {
            try {
                const stem = docInfo.filename.replace(/\.csv$/i, "") || "Sheet1";
                const extract = extractCsv(Buffer.from(raw), stem);
                text = flattenXlsxForLLM(extract);
                console.log(
                    `[read_document] csv extract length=${text.length} for filename="${docInfo.filename}"`,
                );
            } catch (err) {
                console.log(`[read_document] csv extract failed:`, err);
                text = "";
            }
        } else if (docInfo.file_type === "pdf") {
            text = await extractPdfText(raw);
            console.log(
                `[read_document] pdf extracted length=${text.length} for filename="${docInfo.filename}"`,
            );
        } else if (docInfo.file_type === "docx") {
            // Use the same flattening as the edit_document matcher so the
            // LLM sees exactly the characters it can anchor against.
            text = await extractDocxBodyText(Buffer.from(raw));
            console.log(
                `[read_document] docx extractDocxBodyText length=${text.length} for filename="${docInfo.filename}"`,
            );
            if (!text) {
                console.log(
                    `[read_document] docx accepted-view extractor returned empty, falling back to mammoth for filename="${docInfo.filename}"`,
                );
                const mammoth = await import("mammoth");
                const result = await mammoth.extractRawText({
                    buffer: Buffer.from(raw),
                });
                text = result.value;
                console.log(
                    `[read_document] docx mammoth fallback length=${text.length} for filename="${docInfo.filename}"`,
                );
            }
        } else {
            console.log(
                `[read_document] unknown file_type="${docInfo.file_type}" for filename="${docInfo.filename}", trying mammoth`,
            );
            const mammoth = await import("mammoth");
            const result = await mammoth.extractRawText({
                buffer: Buffer.from(raw),
            });
            text = result.value;
            console.log(
                `[read_document] mammoth length=${text.length} for filename="${docInfo.filename}"`,
            );
        }
        console.log(
            `[read_document] DONE filename="${docInfo.filename}" finalTextLength=${text.length} firstChars=${JSON.stringify(text.slice(0, 120))}`,
        );
        emitDocRead();
        return text;
    } catch (err) {
        console.log(
            `[read_document] THREW for docLabel="${docLabel}" filename="${docInfo.filename}":`,
            err,
        );
        if (emitEvents)
            write(
                `data: ${JSON.stringify({ type: "doc_read", filename: docInfo.filename })}\n\n`,
            );
        return "Document could not be read.";
    }
}

/**
 * Build a whitespace-collapsed, lowercased copy of `text`, plus a map from
 * each character index in the normalized form back to the corresponding
 * index in the original text. Used by `findInDocumentContent` so matches
 * are tolerant of case + whitespace variance but can still return the
 * exact original excerpt.
 */
function normalizeWithMap(text: string): { norm: string; origIdx: number[] } {
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch.toLowerCase());
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

function normalizeQuery(q: string): string {
    return q.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Ctrl+F helper. Returns a JSON-serializable result with up to `maxResults`
 * hits, each containing the original-text excerpt plus surrounding context.
 */
export async function findInDocumentContent(params: {
    docLabel: string;
    query: string;
    maxResults?: number;
    contextChars?: number;
    docStore: DocStore;
    write: (s: string) => void;
    docIndex?: DocIndex;
    db?: ReturnType<typeof createServerSupabase>;
}): Promise<string> {
    const {
        docLabel,
        query,
        maxResults = 20,
        contextChars = 80,
        docStore,
        write,
        docIndex,
        db,
    } = params;

    if (!query || !query.trim()) {
        return JSON.stringify({ ok: false, error: "Empty query." });
    }

    const docInfo = docStore.get(docLabel);
    if (!docInfo) {
        return JSON.stringify({
            ok: false,
            error: `Document '${docLabel}' not found.`,
        });
    }

    // Announce the search to the UI, then reuse readDocumentContent for its
    // fallbacks — but suppress its own doc_read events so the user only sees
    // the doc_find block (not a competing doc_read block for the same op).
    write(
        `data: ${JSON.stringify({
            type: "doc_find_start",
            filename: docInfo.filename,
            query,
        })}\n\n`,
    );

    const text = await readDocumentContent(
        docLabel,
        docStore,
        write,
        docIndex,
        db,
        { emitEvents: false },
    );
    if (!text || text === "Document could not be read.") {
        write(
            `data: ${JSON.stringify({
                type: "doc_find",
                filename: docInfo.filename,
                query,
                total_matches: 0,
            })}\n\n`,
        );
        return JSON.stringify({
            ok: false,
            filename: docInfo.filename,
            error: "Document could not be read.",
        });
    }

    const { norm, origIdx } = normalizeWithMap(text);
    const needle = normalizeQuery(query);
    if (!needle) {
        return JSON.stringify({
            ok: false,
            error: "Empty query after normalization.",
        });
    }

    type Hit = {
        index: number;
        excerpt: string;
        context: string;
    };
    const hits: Hit[] = [];
    let from = 0;
    while (from <= norm.length - needle.length && hits.length < maxResults) {
        const pos = norm.indexOf(needle, from);
        if (pos < 0) break;
        const endNormPos = pos + needle.length;
        const origStart = origIdx[pos] ?? 0;
        const origEnd =
            endNormPos - 1 < origIdx.length
                ? origIdx[endNormPos - 1] + 1
                : text.length;
        const ctxStart = Math.max(0, origStart - contextChars);
        const ctxEnd = Math.min(text.length, origEnd + contextChars);
        hits.push({
            index: hits.length,
            excerpt: text.slice(origStart, origEnd),
            context:
                (ctxStart > 0 ? "…" : "") +
                text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() +
                (ctxEnd < text.length ? "…" : ""),
        });
        from = pos + Math.max(1, needle.length);
    }

    // Count total occurrences beyond the cap so the model knows whether to narrow the query.
    let totalMatches = hits.length;
    if (hits.length >= maxResults) {
        let probe = from;
        while (probe <= norm.length - needle.length) {
            const pos = norm.indexOf(needle, probe);
            if (pos < 0) break;
            totalMatches++;
            probe = pos + Math.max(1, needle.length);
        }
    }

    write(
        `data: ${JSON.stringify({
            type: "doc_find",
            filename: docInfo.filename,
            query,
            total_matches: totalMatches,
        })}\n\n`,
    );

    return JSON.stringify({
        ok: true,
        filename: docInfo.filename,
        query,
        total_matches: totalMatches,
        returned: hits.length,
        truncated: totalMatches > hits.length,
        hits,
    });
}
