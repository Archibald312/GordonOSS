// Phase 8: orchestrator that turns a (document or project) into findings.
//
// Loads document bytes via the existing PDF/DOCX/XLSX reading helpers,
// runs the deterministic extractors, then dispatches to compareToXbrl
// (intra-doc) and/or compareToProse (cross-doc). All persistence + audit
// happens in the route — this module returns plain data.

import { randomUUID } from "crypto";
import { downloadFile } from "../storage";
import { extractDocxBodyText } from "../docxTrackedChanges";
import { extractPdfText } from "../tools/shared/documentReading";
import { extractXlsx, flattenXlsxForLLM } from "../extractors/xlsx";
import { extractCsv } from "../extractors/csv";
import { loadActiveVersion } from "../documentVersions";
import { buildFactTuples, type FactTuple } from "../extractors/factTuples";
import type { GazetteerEntry } from "../extractors/entities";
import {
    compareToProse,
    compareToXbrl,
    type Finding,
    type XbrlFactRow,
} from "./compare";
import type { createServerSupabase } from "../supabase";

type Db = ReturnType<typeof createServerSupabase>;

interface DocumentRow {
    id: string;
    user_id: string;
    project_id: string | null;
    filename: string;
    file_type: string | null;
    source_connector: string | null;
    source_ref: Record<string, unknown> | null;
}

async function loadDocument(db: Db, documentId: string): Promise<DocumentRow | null> {
    const { data, error } = await db
        .from("documents")
        .select(
            "id, user_id, project_id, filename, file_type, source_connector, source_ref",
        )
        .eq("id", documentId)
        .single();
    if (error || !data) return null;
    return data as DocumentRow;
}

async function loadDocumentText(
    db: Db,
    doc: DocumentRow,
): Promise<string> {
    const version = await loadActiveVersion(doc.id, db);
    if (!version) return "";
    const raw = await downloadFile(version.storage_path);
    if (!raw) return "";
    const ft = (doc.file_type ?? "").toLowerCase();
    const filename = doc.filename.toLowerCase();

    if (ft === "pdf" || filename.endsWith(".pdf")) {
        return extractPdfText(raw);
    }
    if (
        ft === "docx" ||
        filename.endsWith(".docx") ||
        filename.endsWith(".doc")
    ) {
        return extractDocxBodyText(Buffer.from(raw));
    }
    if (
        ft === "xlsx" ||
        ft === "xls" ||
        ft === "xlsm" ||
        filename.endsWith(".xlsx") ||
        filename.endsWith(".xlsm")
    ) {
        const extract = await extractXlsx(Buffer.from(raw));
        return flattenXlsxForLLM(extract);
    }
    if (ft === "csv" || filename.endsWith(".csv")) {
        const extract = extractCsv(Buffer.from(raw));
        return flattenXlsxForLLM(extract);
    }
    if (ft === "html" || filename.endsWith(".htm") || filename.endsWith(".html")) {
        // Cheap strip — connectors transcode to PDF by default, this is a
        // fallback for the rare case where transcoding failed at ingest.
        return Buffer.from(raw)
            .toString("utf-8")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }
    return "";
}

async function loadGazetteer(db: Db, projectId: string | null): Promise<GazetteerEntry[]> {
    // Seed from edgar_facts: any (cik, accession) we've ingested implies
    // an issuer worth knowing about. We pull distinct CIKs and pair them
    // with the filing's stored source_ref (which carries ticker + form).
    const query = db
        .from("documents")
        .select("source_ref")
        .eq("source_connector", "edgar");
    const scoped = projectId ? query.eq("project_id", projectId) : query;
    const { data, error } = await scoped;
    if (error || !data) return [];
    const byCik = new Map<string, GazetteerEntry>();
    for (const row of data as Array<{ source_ref: Record<string, unknown> | null }>) {
        const ref = row.source_ref;
        if (!ref) continue;
        const cik = typeof ref.cik === "string" ? ref.cik : null;
        if (!cik) continue;
        const ticker = typeof ref.ticker === "string" ? ref.ticker : null;
        // Without a canonical issuer name in source_ref today, ticker is
        // our best lookup token. Aliases are open for Phase 11 enrichment.
        if (byCik.has(cik)) continue;
        byCik.set(cik, {
            canonicalId: cik,
            name: ticker ?? `CIK ${cik}`,
            ticker,
        });
    }
    return Array.from(byCik.values());
}

async function loadXbrlFactsForAccession(
    db: Db,
    accessionNumber: string,
): Promise<XbrlFactRow[]> {
    const { data, error } = await db
        .from("edgar_facts")
        .select(
            "id, document_id, concept, value_numeric, value_text, unit, period_start, period_end, instant, decimals",
        )
        .eq("accession_number", accessionNumber);
    if (error || !data) return [];
    return (
        data as Array<{
            id: string;
            document_id: string;
            concept: string;
            value_numeric: number | null;
            value_text: string | null;
            unit: string | null;
            period_start: string | null;
            period_end: string | null;
            instant: string | null;
            decimals: number | null;
        }>
    ).map((r) => ({
        id: r.id,
        documentId: r.document_id,
        concept: r.concept,
        valueNumeric: r.value_numeric,
        valueText: r.value_text ?? "",
        unit: r.unit,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        instant: r.instant,
        decimals: r.decimals,
    }));
}

async function listSiblingDocs(
    db: Db,
    projectId: string,
    excludeId: string,
): Promise<DocumentRow[]> {
    const { data, error } = await db
        .from("documents")
        .select(
            "id, user_id, project_id, filename, file_type, source_connector, source_ref",
        )
        .eq("project_id", projectId)
        .neq("id", excludeId)
        .limit(20);
    if (error || !data) return [];
    return data as DocumentRow[];
}

export interface RunResult {
    runId: string;
    proseTuplesByDoc: Record<string, number>;
    findings: Finding[];
}

/**
 * Run an intra-doc consistency check: prose-extracted tuples in the target
 * document compared against the same accession's XBRL facts (if any).
 */
export async function runConsistencyForDocument(args: {
    db: Db;
    documentId: string;
    crossDoc?: boolean;
}): Promise<RunResult | null> {
    const { db, documentId, crossDoc } = args;
    const doc = await loadDocument(db, documentId);
    if (!doc) return null;

    const gazetteer = await loadGazetteer(db, doc.project_id);
    const text = await loadDocumentText(db, doc);
    const tuples = text ? buildFactTuples(text, { gazetteer }) : [];

    const findings: Finding[] = [];
    const tupleCounts: Record<string, number> = { [documentId]: tuples.length };

    // Intra-doc: XBRL comparison if the filing carried an accession.
    const accession =
        doc.source_connector === "edgar" &&
        doc.source_ref &&
        typeof doc.source_ref.accession_number === "string"
            ? (doc.source_ref.accession_number as string)
            : null;
    if (accession) {
        const xbrl = await loadXbrlFactsForAccession(db, accession);
        findings.push(...compareToXbrl(tuples, documentId, xbrl));
    }

    // Cross-doc: sibling prose comparisons within the project.
    if (crossDoc && doc.project_id) {
        const siblings = await listSiblingDocs(db, doc.project_id, documentId);
        for (const sib of siblings) {
            const sibText = await loadDocumentText(db, sib);
            if (!sibText) continue;
            const sibTuples = buildFactTuples(sibText, { gazetteer });
            tupleCounts[sib.id] = sibTuples.length;
            findings.push(
                ...compareToProse(
                    { documentId, tuples },
                    { documentId: sib.id, tuples: sibTuples },
                ),
            );
        }
    }

    return {
        runId: randomUUID(),
        proseTuplesByDoc: tupleCounts,
        findings,
    };
}

export type { FactTuple };
