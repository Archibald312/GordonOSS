// Phase 8: consistency check routes.
//
// POST /consistency/check
//   Body: { document_id: string, cross_doc?: boolean }
//   Runs extractors + comparison, persists findings, returns the run summary.
//
// GET /consistency/findings?run_id=... | ?project_id=... | ?document_id=...
//   Lists persisted findings, scoped to the caller.
//
// All work is deterministic. The route emits a `consistency_check` audit
// row so investigators can later prove who ran a check and how many
// findings it produced.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { recordAudit } from "../lib/audit";
import { runConsistencyForDocument } from "../lib/consistency/run";
import { persistFindings } from "../lib/consistency/persist";
import { ensureDocAccess } from "../lib/access";

export const consistencyRouter = Router();

consistencyRouter.post("/check", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const documentId =
        typeof body.document_id === "string" ? body.document_id.trim() : "";
    const crossDoc = Boolean(body.cross_doc);
    if (!documentId) {
        return void res.status(400).json({ detail: "document_id is required" });
    }
    const db = createServerSupabase();
    const { data: docRow } = await db
        .from("documents")
        .select("user_id, project_id")
        .eq("id", documentId)
        .single();
    if (!docRow) {
        return void res.status(404).json({ detail: "Document not found" });
    }
    const access = await ensureDocAccess(
        docRow as { user_id: string; project_id: string | null },
        userId,
        userEmail ?? null,
        db,
    );
    if (!access.ok) {
        return void res.status(404).json({ detail: "Document not found" });
    }

    const started = Date.now();
    try {
        const result = await runConsistencyForDocument({
            db,
            documentId,
            crossDoc,
        });
        if (!result) {
            return void res.status(404).json({ detail: "Document not found" });
        }
        const inserted = await persistFindings({
            db,
            runId: result.runId,
            userId,
            // Pull project_id from the target document for scoping.
            projectId: await loadProjectId(db, documentId),
            findings: result.findings,
        });
        await recordAudit(
            {
                eventType: "consistency_check",
                userId,
                userEmail,
                documentIds: [documentId],
                durationMs: Date.now() - started,
                status: "success",
                routingPolicyApplied: {
                    run_id: result.runId,
                    findings_total: result.findings.length,
                    findings_inserted: inserted,
                    cross_doc: crossDoc,
                },
            },
            db,
        );
        return void res.status(201).json({
            run_id: result.runId,
            findings_total: result.findings.length,
            findings_inserted: inserted,
            tuple_counts: result.proseTuplesByDoc,
            findings: result.findings,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[consistency/check]", err);
        await recordAudit(
            {
                eventType: "consistency_check",
                userId,
                userEmail,
                documentIds: [documentId],
                durationMs: Date.now() - started,
                status: "error",
                errorMessage: msg,
            },
            db,
        );
        return void res
            .status(500)
            .json({ detail: `Consistency check failed: ${msg}` });
    }
});

consistencyRouter.get("/findings", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const runId = typeof req.query.run_id === "string" ? req.query.run_id : null;
    const projectId =
        typeof req.query.project_id === "string" ? req.query.project_id : null;
    const documentId =
        typeof req.query.document_id === "string" ? req.query.document_id : null;
    const db = createServerSupabase();

    let q = db
        .from("consistency_findings")
        .select(
            "id, run_id, severity, entity, concept, period_key, left_document_id, left_value_numeric, left_value_text, left_unit, left_byte_offset, left_byte_length, left_quote, right_kind, right_document_id, right_fact_id, right_value_numeric, right_value_text, right_unit, right_byte_offset, right_byte_length, right_quote, details, status, created_at",
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(500);
    if (runId) q = q.eq("run_id", runId);
    if (projectId) q = q.eq("project_id", projectId);
    if (documentId) q = q.eq("left_document_id", documentId);

    const { data, error } = await q;
    if (error) {
        return void res.status(500).json({ detail: error.message });
    }
    return void res.json({ findings: data ?? [] });
});

async function loadProjectId(
    db: ReturnType<typeof createServerSupabase>,
    documentId: string,
): Promise<string | null> {
    const { data } = await db
        .from("documents")
        .select("project_id")
        .eq("id", documentId)
        .single();
    if (!data) return null;
    return (data as { project_id: string | null }).project_id ?? null;
}
