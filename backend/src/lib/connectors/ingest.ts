// Phase 7: shared ingest path for connector-fetched documents.
//
// This is the only file in the connector framework that touches the
// `documents` and `document_versions` tables directly. Each connector
// returns a `ConnectorFetchedDocument` and calls this helper, which:
//
//   1. Looks up an existing row with the same (source_connector,
//      source_ref.accession_number, source_ref.document_role) — if found,
//      returns it as a dedupe hit (no new row, no storage write).
//   2. Inserts the documents row with provenance + model_preference.
//   3. Uploads bytes to R2 (one storage write).
//   4. Inserts the V1 document_versions row.
//   5. Points documents.current_version_id at it and marks the doc ready.
//
// PDF rendition: if the connector hands us a `.pdf` file, we register the
// uploaded path as the rendition too (mirrors handleDocumentUpload). Other
// formats land without a rendition; viewers degrade gracefully.

import { storageKey, uploadFile } from "../storage";
import type { createServerSupabase } from "../supabase";
import type {
    Connector,
    ConnectorFetchedDocument,
    ConnectorIngestResult,
} from "./types";

const PDF_CONTENT_TYPE = "application/pdf";
const XML_CONTENT_TYPE = "application/xml";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

function contentTypeFor(fileType: string): string {
    switch (fileType) {
        case "pdf":
            return PDF_CONTENT_TYPE;
        case "xml":
            return XML_CONTENT_TYPE;
        case "html":
        case "htm":
            return HTML_CONTENT_TYPE;
        case "xlsx":
        case "xlsm":
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        case "csv":
            return "text/csv";
        default:
            return "application/octet-stream";
    }
}

export type IngestArgs = {
    db: ReturnType<typeof createServerSupabase>;
    userId: string;
    projectId: string | null;
    connector: Connector;
    fetched: ConnectorFetchedDocument;
};

export async function ingestConnectorDocument(
    args: IngestArgs,
): Promise<ConnectorIngestResult> {
    const { db, userId, projectId, connector, fetched } = args;

    const accessionNumber = fetched.source_ref.accession_number;
    const documentRole = fetched.source_ref.document_role;
    if (typeof accessionNumber !== "string" || !accessionNumber) {
        throw new Error("source_ref.accession_number is required");
    }
    if (typeof documentRole !== "string" || !documentRole) {
        throw new Error("source_ref.document_role is required");
    }

    // 1. Dedupe — same connector + accession + role = same document.
    //    The DB also enforces this with a unique index, but we check first
    //    so we don't burn a storage write before colliding.
    const { data: existing } = await db
        .from("documents")
        .select("id, current_version_id")
        .eq("source_connector", connector.id)
        .eq("source_ref->>accession_number", accessionNumber)
        .eq("source_ref->>document_role", documentRole)
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();

    if (existing) {
        return {
            document_id: existing.id as string,
            version_id: existing.current_version_id as string,
            deduped: true,
        };
    }

    // 2. Insert documents row up front so we have an id for the storage key.
    const { data: docRow, error: docErr } = await db
        .from("documents")
        .insert({
            project_id: projectId,
            user_id: userId,
            filename: fetched.filename,
            file_type: fetched.file_type,
            size_bytes: fetched.bytes.byteLength,
            status: "processing",
            source_connector: connector.id,
            source_ref: fetched.source_ref,
            model_preference: fetched.model_preference ?? null,
        })
        .select("id")
        .single();
    if (docErr || !docRow) {
        throw new Error(
            `Connector ingest insert failed: ${docErr?.message ?? "unknown"}`,
        );
    }
    const docId = docRow.id as string;

    // 3. Upload bytes.
    const key = storageKey(userId, docId, fetched.filename);
    const ab = fetched.bytes.buffer.slice(
        fetched.bytes.byteOffset,
        fetched.bytes.byteOffset + fetched.bytes.byteLength,
    ) as ArrayBuffer;
    await uploadFile(key, ab, contentTypeFor(fetched.file_type));

    // 4. Create V1 version row. PDF files double as their own rendition.
    const pdfStoragePath = fetched.file_type === "pdf" ? key : null;
    const { data: verRow, error: verErr } = await db
        .from("document_versions")
        .insert({
            document_id: docId,
            storage_path: key,
            pdf_storage_path: pdfStoragePath,
            source: "upload",
            version_number: 1,
            display_name: fetched.filename,
        })
        .select("id")
        .single();
    if (verErr || !verRow) {
        throw new Error(
            `Connector ingest version insert failed: ${verErr?.message ?? "unknown"}`,
        );
    }

    // 5. Mark ready and point current_version_id at V1.
    await db
        .from("documents")
        .update({
            current_version_id: verRow.id,
            status: "ready",
            updated_at: new Date().toISOString(),
        })
        .eq("id", docId);

    return {
        document_id: docId,
        version_id: verRow.id as string,
        deduped: false,
    };
}
