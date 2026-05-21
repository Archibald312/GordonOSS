// Phase 7: connector routes.
//
// Backend-only API surface for connector framework. No UI yet — by design
// (see decisions.md 2026-05-15). Today only EDGAR is wired; Phase 11 adds
// Google Drive + Capital IQ on the same /connectors prefix.
//
// Every successful ingest writes a `connector_fetch` audit row so we can
// later prove which user pulled which filing.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { recordAudit } from "../lib/audit";
import { EdgarClient } from "../lib/connectors/edgar/client";
import { registerEdgarConnector } from "../lib/connectors/edgar";
import { getConnector } from "../lib/connectors/registry";

export const connectorsRouter = Router();

function tryRegisterEdgar(): void {
    try {
        registerEdgarConnector();
    } catch (err) {
        // EDGAR_USER_AGENT not set — log once at startup so ops sees it.
        console.warn(
            "[connectors] EDGAR not registered:",
            err instanceof Error ? err.message : String(err),
        );
    }
}
tryRegisterEdgar();

function edgarClientOrNull(): EdgarClient | null {
    try {
        return new EdgarClient();
    } catch (err) {
        console.warn(
            "[connectors/edgar] client unavailable:",
            err instanceof Error ? err.message : String(err),
        );
        return null;
    }
}

// POST /connectors/edgar/lookup
// Body: { ticker?: string, cik?: string }
// Resolves a company by ticker (uses SEC's ticker list) or normalizes a CIK
// to 10-digit form.
connectorsRouter.post("/edgar/lookup", requireAuth, async (req, res) => {
    const { ticker, cik } = (req.body ?? {}) as {
        ticker?: string;
        cik?: string;
    };
    const client = edgarClientOrNull();
    if (!client) {
        return void res
            .status(503)
            .json({ detail: "EDGAR_USER_AGENT not configured." });
    }
    try {
        if (typeof ticker === "string" && ticker.trim()) {
            const out = await client.lookupByTicker(ticker.trim());
            if (!out)
                return void res
                    .status(404)
                    .json({ detail: "Ticker not found" });
            return void res.json(out);
        }
        if (typeof cik === "string" && cik.trim()) {
            const padded = cik.replace(/\D/g, "").padStart(10, "0");
            return void res.json({
                cik: padded,
                ticker: null,
                name: null,
            });
        }
        return void res
            .status(400)
            .json({ detail: "ticker or cik is required" });
    } catch (err) {
        console.error("[connectors/edgar/lookup]", err);
        return void res
            .status(502)
            .json({ detail: "EDGAR lookup failed" });
    }
});

// GET /connectors/edgar/filings?cik=...&form_types=10-K,10-Q&limit=20
connectorsRouter.get("/edgar/filings", requireAuth, async (req, res) => {
    const cik = typeof req.query.cik === "string" ? req.query.cik : "";
    if (!cik) {
        return void res.status(400).json({ detail: "cik is required" });
    }
    const formTypes =
        typeof req.query.form_types === "string"
            ? req.query.form_types
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
            : undefined;
    const limit =
        typeof req.query.limit === "string"
            ? Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50))
            : 50;
    const client = edgarClientOrNull();
    if (!client) {
        return void res
            .status(503)
            .json({ detail: "EDGAR_USER_AGENT not configured." });
    }
    try {
        const filings = await client.getRecentFilings(cik, {
            formTypes,
            limit,
        });
        return void res.json({ cik, filings });
    } catch (err) {
        console.error("[connectors/edgar/filings]", err);
        return void res
            .status(502)
            .json({ detail: "EDGAR filings lookup failed" });
    }
});

// POST /connectors/edgar/ingest
// Body: {
//   cik: string,
//   accession_number: string,
//   form?: string,
//   filing_date?: string,
//   report_date?: string,
//   ticker?: string,
//   project_id?: string | null,
//   include_exhibits?: boolean,
//   extract_xbrl?: boolean
// }
connectorsRouter.post("/edgar/ingest", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cik = typeof body.cik === "string" ? body.cik.trim() : "";
    const accession =
        typeof body.accession_number === "string"
            ? body.accession_number.trim()
            : "";
    if (!cik || !accession) {
        return void res
            .status(400)
            .json({ detail: "cik and accession_number are required" });
    }
    const projectId =
        typeof body.project_id === "string" && body.project_id.trim()
            ? body.project_id.trim()
            : null;

    const connector = getConnector("edgar");
    if (!connector) {
        return void res
            .status(503)
            .json({ detail: "EDGAR connector not registered (EDGAR_USER_AGENT missing?)" });
    }

    const db = createServerSupabase();
    const started = Date.now();
    try {
        const { EdgarConnector } = await import("../lib/connectors/edgar");
        const edgar = connector as InstanceType<typeof EdgarConnector>;
        const result = await edgar.ingestFiling({
            db,
            userId,
            projectId,
            opts: {
                cik,
                accessionNumber: accession,
                form: typeof body.form === "string" ? body.form : undefined,
                filingDate:
                    typeof body.filing_date === "string"
                        ? body.filing_date
                        : undefined,
                reportDate:
                    typeof body.report_date === "string"
                        ? body.report_date
                        : undefined,
                ticker:
                    typeof body.ticker === "string" ? body.ticker : null,
                includeExhibits: Boolean(body.include_exhibits),
                extractXbrl: Boolean(body.extract_xbrl),
                primaryDocument:
                    typeof body.primary_document === "string"
                        ? body.primary_document
                        : undefined,
            },
        });

        const docIds: string[] = [];
        if (result.primary) docIds.push(result.primary.document_id);
        for (const ex of result.exhibits) docIds.push(ex.document_id);
        if (result.xbrl) docIds.push(result.xbrl.document_id);

        await recordAudit(
            {
                eventType: "connector_fetch",
                userId,
                userEmail,
                connectorId: "edgar",
                projectId,
                documentIds: docIds,
                sourceLicenseScopes: ["public"],
                durationMs: Date.now() - started,
                status: "success",
            },
            db,
        );

        return void res.status(201).json(result);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[connectors/edgar/ingest]", err);
        await recordAudit(
            {
                eventType: "connector_fetch",
                userId,
                userEmail,
                connectorId: "edgar",
                projectId,
                durationMs: Date.now() - started,
                status: "error",
                errorMessage: msg,
            },
            db,
        );
        return void res
            .status(502)
            .json({ detail: `EDGAR ingest failed: ${msg}` });
    }
});
