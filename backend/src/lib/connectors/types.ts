// Phase 7: connector framework — shared types.
//
// Connectors fetch documents from outside systems (EDGAR today, Google Drive
// and Capital IQ in Phase 11) and ingest them via the same path manual
// uploads use. Each connector implements `Connector` and registers itself
// via `registry.ts`.
//
// The framework deliberately stays thin: each connector owns its own client,
// own auth model, and own search/list/fetch primitives. The shared seam is
// only the ingest helper (`ingestConnectorDocument`) — that way Phase 11
// connectors don't have to know how documents/document_versions are laid out.

import type { createServerSupabase } from "../supabase";

export type ConnectorId = "edgar" | (string & {});

/** Role of a fetched document inside its source-system grouping. */
export type ConnectorDocumentRole = "primary" | "exhibit" | "xbrl" | "other";

/**
 * Connector-specific provenance metadata persisted on `documents.source_ref`.
 * Each connector defines its own shape; only `document_role` is required by
 * the dedupe index. Keep keys snake_case to match the on-disk jsonb.
 */
export type ConnectorSourceRef = {
    document_role: ConnectorDocumentRole;
    [k: string]: unknown;
};

/**
 * A document fetched from an external system, ready to ingest.
 *
 * `bytes` is the raw payload (HTML, PDF, XBRL XML, etc.). `file_type` is the
 * normalized extension as it should appear on the documents row — for HTML
 * filings that we transcode to PDF on ingest, set this to "pdf" and pass the
 * transcoded bytes. Conversion is the connector's job, not the framework's,
 * so the connector picks the policy (transcode vs. store as-is).
 */
export type ConnectorFetchedDocument = {
    filename: string;
    file_type: string;
    bytes: Buffer;
    /** Connector provenance — persisted to `documents.source_ref` verbatim. */
    source_ref: ConnectorSourceRef;
    /** Optional model preference to write into `documents.model_preference`. */
    model_preference?: string | null;
};

/** Result of ingesting one fetched document. */
export type ConnectorIngestResult = {
    document_id: string;
    version_id: string;
    deduped: boolean;
};

/** Common config passed to every connector method. */
export type ConnectorContext = {
    db: ReturnType<typeof createServerSupabase>;
    userId: string;
    projectId?: string | null;
};

export interface Connector {
    id: ConnectorId;
    /** Human-readable name for logs / future UI. */
    displayName: string;
}
