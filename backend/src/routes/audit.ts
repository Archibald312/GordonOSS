import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

export const auditRouter = Router();

const EVENT_TYPES = new Set([
    "llm_call",
    "tool_call",
    "connector_fetch",
    "document_upload",
    "document_download",
]);

function parseTimestamp(value: unknown): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

function parseIntInRange(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number {
    if (typeof value !== "string" || !value.trim()) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

// GET /audit-log
// User-scoped — every caller sees only their own rows.
auditRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();

    const projectIdRaw = req.query.project_id;
    const eventTypeRaw = req.query.event_type;
    const fromRaw = req.query.from;
    const toRaw = req.query.to;

    if (projectIdRaw !== undefined && typeof projectIdRaw !== "string") {
        return void res
            .status(400)
            .json({ detail: "project_id must be a string" });
    }
    if (
        eventTypeRaw !== undefined &&
        (typeof eventTypeRaw !== "string" || !EVENT_TYPES.has(eventTypeRaw))
    ) {
        return void res.status(400).json({ detail: "invalid event_type" });
    }
    const from = parseTimestamp(fromRaw);
    if (fromRaw !== undefined && from === null) {
        return void res.status(400).json({ detail: "from is not a valid date" });
    }
    const to = parseTimestamp(toRaw);
    if (toRaw !== undefined && to === null) {
        return void res.status(400).json({ detail: "to is not a valid date" });
    }

    const limit = parseIntInRange(req.query.limit, 100, 1, 1000);
    const offset = parseIntInRange(req.query.offset, 0, 0, 1_000_000);

    let query = db
        .from("audit_log")
        .select("*", { count: "exact" })
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

    if (typeof projectIdRaw === "string" && projectIdRaw.trim()) {
        query = query.eq("project_id", projectIdRaw);
    }
    if (typeof eventTypeRaw === "string") {
        query = query.eq("event_type", eventTypeRaw);
    }
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);

    const { data, error, count } = await query;
    if (error) return void res.status(500).json({ detail: error.message });

    res.json({
        entries: data ?? [],
        limit,
        offset,
        total: count ?? null,
    });
});
