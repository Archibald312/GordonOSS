// EDGAR connector — Tier 1 reference implementation of the Phase 7
// connector framework.
//
// Workflow on `ingestFiling`:
//   1. Resolve the filing's document index.
//   2. Fetch the primary document. If HTML, transcode to PDF so citations
//      work identically to manual PDF uploads.
//   3. Optionally fetch each exhibit as its own document row, linked by
//      accession_number via source_ref.
//   4. Optionally fetch the XBRL instance doc, parse facts, persist a row
//      per fact into edgar_facts. The XBRL XML itself also lands as a
//      document row (document_role='xbrl') so it's auditable.

import { htmlToPdf } from "../../convert";
import { registerConnector } from "../registry";
import { ingestConnectorDocument } from "../ingest";
import type {
    Connector,
    ConnectorFetchedDocument,
    ConnectorSourceRef,
} from "../types";
import type { createServerSupabase } from "../../supabase";
import { EdgarClient, type SecFilingDocument } from "./client";
import { extractXbrlFacts, type XbrlFact } from "./xbrl";

const EDGAR_CONNECTOR_ID = "edgar";

export type EdgarIngestOptions = {
    cik: string;
    accessionNumber: string;
    form?: string;
    filingDate?: string;
    reportDate?: string;
    ticker?: string | null;
    includeExhibits?: boolean;
    extractXbrl?: boolean;
};

export type EdgarIngestResult = {
    primary: { document_id: string; deduped: boolean } | null;
    exhibits: Array<{ document_id: string; deduped: boolean; filename: string }>;
    xbrl: {
        document_id: string;
        deduped: boolean;
        facts_inserted: number;
    } | null;
};

function pickExhibitFiles(docs: SecFilingDocument[], primary: string): SecFilingDocument[] {
    return docs.filter(
        (d) =>
            d.name !== primary &&
            // Skip XBRL components — we handle XBRL separately when requested.
            !/\.(xml|xsd)$/i.test(d.name) &&
            // Skip the SEC's pre-computed financial reports + R-files.
            !/^R\d+\.htm$/i.test(d.name) &&
            !/^Financial_Report\.xlsx$/i.test(d.name) &&
            // Skip metadata files.
            !/^MetaLinks\.json$/i.test(d.name) &&
            !/^FilingSummary\.xml$/i.test(d.name),
    );
}

function findXbrlInstance(docs: SecFilingDocument[]): SecFilingDocument | null {
    // The XBRL instance is conventionally named <ticker>-<period>.xml or
    // <ticker>-<period>_htm.xml. We pick the largest .xml that isn't an
    // FilingSummary or a schema.
    const candidates = docs.filter(
        (d) =>
            /\.xml$/i.test(d.name) &&
            !/FilingSummary\.xml$/i.test(d.name) &&
            !/_cal\.xml$/i.test(d.name) &&
            !/_def\.xml$/i.test(d.name) &&
            !/_lab\.xml$/i.test(d.name) &&
            !/_pre\.xml$/i.test(d.name),
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.size - a.size);
    return candidates[0] ?? null;
}

function periodKeyFor(fact: XbrlFact): {
    period_start: string | null;
    period_end: string | null;
    instant: string | null;
} {
    if (fact.period.kind === "duration") {
        return {
            period_start: fact.period.start,
            period_end: fact.period.end,
            instant: null,
        };
    }
    return {
        period_start: null,
        period_end: null,
        instant: fact.period.date,
    };
}

export class EdgarConnector implements Connector {
    readonly id = EDGAR_CONNECTOR_ID;
    readonly displayName = "SEC EDGAR";
    private readonly client: EdgarClient;

    constructor(client?: EdgarClient) {
        this.client = client ?? new EdgarClient();
    }

    async ingestFiling(args: {
        db: ReturnType<typeof createServerSupabase>;
        userId: string;
        projectId: string | null;
        opts: EdgarIngestOptions;
        // Allow tests to stub conversion (LibreOffice may be missing).
        htmlToPdfImpl?: (b: Buffer) => Promise<Buffer>;
    }): Promise<EdgarIngestResult> {
        const { db, userId, projectId, opts } = args;
        const transcode = args.htmlToPdfImpl ?? htmlToPdf;

        const index = await this.client.getFilingIndex(
            opts.cik,
            opts.accessionNumber,
        );

        const sharedRef = {
            accession_number: opts.accessionNumber,
            cik: opts.cik,
            form_type: opts.form ?? null,
            period_of_report: opts.reportDate ?? null,
            filing_date: opts.filingDate ?? null,
            ticker: opts.ticker ?? null,
        } as const;

        const result: EdgarIngestResult = {
            primary: null,
            exhibits: [],
            xbrl: null,
        };

        // 1. Primary document.
        if (index.primary_document) {
            const primaryBytes = await this.client.getFilingDocument(
                opts.cik,
                opts.accessionNumber,
                index.primary_document,
            );
            const isHtml = /\.(htm|html)$/i.test(index.primary_document);
            let bytes = primaryBytes;
            let fileType = isHtml ? "html" : pickExt(index.primary_document);
            let filename = index.primary_document;
            if (isHtml) {
                try {
                    bytes = await transcode(primaryBytes);
                    fileType = "pdf";
                    filename = index.primary_document.replace(
                        /\.(htm|html)$/i,
                        ".pdf",
                    );
                } catch (err) {
                    console.error(
                        `[edgar] HTML→PDF failed for ${index.primary_document}; storing HTML as-is`,
                        err,
                    );
                }
            }
            const fetched: ConnectorFetchedDocument = {
                filename,
                file_type: fileType,
                bytes,
                source_ref: {
                    ...sharedRef,
                    document_role: "primary",
                    primary_doc_url: filename,
                } as ConnectorSourceRef,
            };
            const ingested = await ingestConnectorDocument({
                db,
                userId,
                projectId,
                connector: this,
                fetched,
            });
            result.primary = {
                document_id: ingested.document_id,
                deduped: ingested.deduped,
            };
        }

        // 2. Exhibits.
        if (opts.includeExhibits) {
            for (const exhibit of pickExhibitFiles(
                index.documents,
                index.primary_document,
            )) {
                const exhibitBytes = await this.client.getFilingDocument(
                    opts.cik,
                    opts.accessionNumber,
                    exhibit.name,
                );
                const isHtml = /\.(htm|html)$/i.test(exhibit.name);
                let bytes = exhibitBytes;
                let fileType = isHtml ? "html" : pickExt(exhibit.name);
                let filename = exhibit.name;
                if (isHtml) {
                    try {
                        bytes = await transcode(exhibitBytes);
                        fileType = "pdf";
                        filename = exhibit.name.replace(
                            /\.(htm|html)$/i,
                            ".pdf",
                        );
                    } catch (err) {
                        console.error(
                            `[edgar] HTML→PDF failed for exhibit ${exhibit.name}; storing as-is`,
                            err,
                        );
                    }
                }
                const fetched: ConnectorFetchedDocument = {
                    filename,
                    file_type: fileType,
                    bytes,
                    source_ref: {
                        ...sharedRef,
                        document_role: "exhibit",
                        exhibit_type: exhibit.type,
                        exhibit_filename: exhibit.name,
                    } as ConnectorSourceRef,
                };
                const ingested = await ingestConnectorDocument({
                    db,
                    userId,
                    projectId,
                    connector: this,
                    fetched,
                });
                result.exhibits.push({
                    document_id: ingested.document_id,
                    deduped: ingested.deduped,
                    filename: exhibit.name,
                });
            }
        }

        // 3. XBRL instance + facts.
        if (opts.extractXbrl) {
            const xbrlDoc = findXbrlInstance(index.documents);
            if (xbrlDoc) {
                const xbrlBytes = await this.client.getFilingDocument(
                    opts.cik,
                    opts.accessionNumber,
                    xbrlDoc.name,
                );
                const fetched: ConnectorFetchedDocument = {
                    filename: xbrlDoc.name,
                    file_type: "xml",
                    bytes: xbrlBytes,
                    source_ref: {
                        ...sharedRef,
                        document_role: "xbrl",
                        xbrl_filename: xbrlDoc.name,
                    } as ConnectorSourceRef,
                };
                const ingested = await ingestConnectorDocument({
                    db,
                    userId,
                    projectId,
                    connector: this,
                    fetched,
                });
                let factsInserted = 0;
                if (!ingested.deduped) {
                    factsInserted = await this.persistXbrlFacts(
                        db,
                        ingested.document_id,
                        opts.accessionNumber,
                        opts.cik,
                        xbrlBytes,
                    );
                }
                result.xbrl = {
                    document_id: ingested.document_id,
                    deduped: ingested.deduped,
                    facts_inserted: factsInserted,
                };
            }
        }

        return result;
    }

    private async persistXbrlFacts(
        db: ReturnType<typeof createServerSupabase>,
        documentId: string,
        accessionNumber: string,
        cik: string,
        xbrlBytes: Buffer,
    ): Promise<number> {
        const facts = extractXbrlFacts(xbrlBytes);
        if (facts.length === 0) return 0;
        const rows = facts.map((f) => {
            const period = periodKeyFor(f);
            return {
                document_id: documentId,
                accession_number: accessionNumber,
                cik,
                concept: f.concept,
                value_numeric: f.valueNumeric,
                value_text: f.valueText,
                unit: f.unit,
                period_start: period.period_start,
                period_end: period.period_end,
                instant: period.instant,
                context_ref: f.contextRef,
                decimals: f.decimals,
            };
        });
        // Chunk to keep payloads sane on filings with thousands of facts.
        const CHUNK = 500;
        let inserted = 0;
        for (let i = 0; i < rows.length; i += CHUNK) {
            const slice = rows.slice(i, i + CHUNK);
            const { error } = await db.from("edgar_facts").insert(slice);
            if (error) {
                console.error("[edgar] edgar_facts insert failed", error);
                break;
            }
            inserted += slice.length;
        }
        return inserted;
    }
}

function pickExt(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "bin";
}

let registered = false;
export function registerEdgarConnector(client?: EdgarClient): EdgarConnector {
    const connector = new EdgarConnector(client);
    if (!registered) {
        registerConnector(connector);
        registered = true;
    }
    return connector;
}
