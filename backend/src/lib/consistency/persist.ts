// Phase 8: persist consistency findings to the `consistency_findings` table.
//
// One row per Finding. Lifecycle starts as 'open' — Phase 11+ may surface
// a UI to mark findings 'resolved' or 'dismissed'. Insert order does not
// matter (DB orders by created_at; UI orders by severity then offset).

import type { createServerSupabase } from "../supabase";
import type { Finding } from "./compare";

type Db = ReturnType<typeof createServerSupabase>;

export interface PersistArgs {
    runId: string;
    userId: string;
    projectId: string | null;
    findings: Finding[];
    db: Db;
}

export async function persistFindings(args: PersistArgs): Promise<number> {
    const { runId, userId, projectId, findings, db } = args;
    if (findings.length === 0) return 0;
    const rows = findings.map((f) => ({
        run_id: runId,
        user_id: userId,
        project_id: projectId,
        severity: f.severity,
        entity: f.entity,
        concept: f.concept,
        period_key: f.periodKey,
        left_document_id: f.left.documentId,
        left_value_numeric: f.left.valueNumeric,
        left_value_text: f.left.valueText,
        left_unit: f.left.unit,
        left_byte_offset: f.left.byteOffset,
        left_byte_length: f.left.byteLength,
        left_quote: f.left.quote,
        right_kind: f.right.kind,
        right_document_id: f.right.documentId,
        right_fact_id: f.right.factId ?? null,
        right_value_numeric: f.right.valueNumeric,
        right_value_text: f.right.valueText,
        right_unit: f.right.unit,
        right_byte_offset: f.right.byteOffset,
        right_byte_length: f.right.byteLength,
        right_quote: f.right.quote,
        details: f.details,
    }));
    const CHUNK = 500;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { error } = await db.from("consistency_findings").insert(slice);
        if (error) {
            console.error("[consistency] insert failed:", error.message);
            break;
        }
        inserted += slice.length;
    }
    return inserted;
}
