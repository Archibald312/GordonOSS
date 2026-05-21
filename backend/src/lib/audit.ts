import { createHash } from "crypto";
import type { createServerSupabase } from "./supabase";

export type AuditEventType =
    | "llm_call"
    | "tool_call"
    | "connector_fetch"
    | "document_upload"
    | "document_download"
    | "consistency_check";

export type AuditStatus = "success" | "error" | "blocked";

export type LicenseScope = "public" | "licensed" | "internal";

export interface AuditEntry {
    eventType: AuditEventType;
    userId: string;
    userEmail?: string;
    model?: string;
    provider?: string;
    toolName?: string;
    connectorId?: string;
    projectId?: string | null;
    documentIds?: string[];
    sourceLicenseScopes?: LicenseScope[];
    routingPolicyApplied?: Record<string, unknown>;
    inputHash?: string;
    outputHash?: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
    status: AuditStatus;
    errorMessage?: string;
}

type Db = ReturnType<typeof createServerSupabase>;

export function hashContent(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
}

function isAuditEnabled(): boolean {
    const raw = process.env.AUDIT_LOG_ENABLED;
    if (raw === undefined) return true;
    return !/^(0|false|no|off)$/i.test(raw.trim());
}

/**
 * Insert a single audit_log row. Fire-and-forget semantics: errors are
 * logged but never propagated — audit failures must not break the user
 * request. Callers may still `await` to ensure ordering within a turn.
 */
export async function recordAudit(entry: AuditEntry, db: Db): Promise<void> {
    if (!isAuditEnabled()) return;

    try {
        const row = {
            user_id: entry.userId,
            user_email: entry.userEmail ?? null,
            event_type: entry.eventType,
            model: entry.model ?? null,
            provider: entry.provider ?? null,
            tool_name: entry.toolName ?? null,
            connector_id: entry.connectorId ?? null,
            project_id: entry.projectId ?? null,
            document_ids: entry.documentIds?.length ? entry.documentIds : null,
            source_license_scopes: entry.sourceLicenseScopes?.length
                ? entry.sourceLicenseScopes
                : null,
            routing_policy_applied: entry.routingPolicyApplied ?? null,
            input_hash: entry.inputHash ?? null,
            output_hash: entry.outputHash ?? null,
            input_tokens: entry.inputTokens ?? null,
            output_tokens: entry.outputTokens ?? null,
            duration_ms: entry.durationMs ?? null,
            status: entry.status,
            error_message: entry.errorMessage ?? null,
        };

        const { error } = await db.from("audit_log").insert(row);
        if (error) {
            console.error("[audit] insert failed:", error.message);
        }
    } catch (err) {
        console.error(
            "[audit] unexpected failure:",
            err instanceof Error ? err.message : String(err),
        );
    }
}
