import type { createServerSupabase } from "../supabase";
import { resolveModel } from "./models";

// Per-source LLM routing seam — see decisions.md (2026-05-15).
//
// Today this resolver returns the caller's requested model unchanged in the
// common case (no documents, no project overrides). The point of landing it
// now is to put a single decision surface between every dispatch site and the
// adapter, so that Phase 7 connectors and the post-launch local-inference
// adapter can both plug in without touching call sites.
//
// Precedence:
//   1. document.model_preference  (first non-null wins; conflicts logged)
//   2. project.model_preference
//   3. requested model
//
// Unknown / unrecognized model strings fall through to the next level and the
// rejection is captured in the policy for audit.

type Db = ReturnType<typeof createServerSupabase>;

export type ModelRoutingContext = {
    db: Db;
    projectId?: string | null;
    documentIds?: string[];
};

export type ModelRoutingSource = "request" | "project" | "document";

export type ModelRoutingPolicy = {
    requestedModel: string;
    resolvedModel: string;
    source: ModelRoutingSource;
    projectOverride?: string | null;
    documentOverrides?: Array<{
        documentId: string;
        modelPreference: string;
    }>;
    /** Recorded when >1 document declares a preference and they disagree. */
    conflicts?: Array<{ documentId: string; modelPreference: string }>;
    /** Recorded when a stored preference references an unknown model id. */
    rejected?: Array<{
        layer: "project" | "document";
        id: string;
        modelPreference: string;
        reason: "unknown_model_id";
    }>;
};

export type ResolvedRouting = {
    model: string;
    policy: ModelRoutingPolicy;
};

export async function resolveModelRouting(
    ctx: ModelRoutingContext,
    requestedModel: string,
): Promise<ResolvedRouting> {
    const policy: ModelRoutingPolicy = {
        requestedModel,
        resolvedModel: requestedModel,
        source: "request",
    };

    const documentIds = (ctx.documentIds ?? []).filter(
        (id): id is string => typeof id === "string" && id.length > 0,
    );

    const documentPrefs: Array<{ documentId: string; modelPreference: string }> = [];
    if (documentIds.length > 0) {
        const { data, error } = await ctx.db
            .from("documents")
            .select("id, model_preference")
            .in("id", documentIds);
        if (error) {
            console.error(
                "[routing] documents lookup failed:",
                error.message,
            );
        } else if (data) {
            for (const row of data as Array<{
                id: string;
                model_preference: string | null;
            }>) {
                if (row.model_preference) {
                    documentPrefs.push({
                        documentId: row.id,
                        modelPreference: row.model_preference,
                    });
                }
            }
        }
    }

    let projectPref: string | null = null;
    if (ctx.projectId) {
        const { data, error } = await ctx.db
            .from("projects")
            .select("model_preference")
            .eq("id", ctx.projectId)
            .maybeSingle();
        if (error) {
            console.error("[routing] project lookup failed:", error.message);
        } else if (data) {
            const row = data as { model_preference: string | null };
            projectPref = row.model_preference ?? null;
        }
    }

    if (documentPrefs.length > 0) {
        policy.documentOverrides = documentPrefs;
        const winner = documentPrefs[0];
        const validated = resolveModel(winner.modelPreference, "");
        if (validated) {
            policy.source = "document";
            policy.resolvedModel = validated;
            const conflicts = documentPrefs.slice(1).filter(
                (p) => p.modelPreference !== winner.modelPreference,
            );
            if (conflicts.length > 0) policy.conflicts = conflicts;
            if (projectPref !== null) policy.projectOverride = projectPref;
            return { model: validated, policy };
        }
        // First preference is unknown — reject it and keep walking.
        policy.rejected = [
            ...(policy.rejected ?? []),
            {
                layer: "document",
                id: winner.documentId,
                modelPreference: winner.modelPreference,
                reason: "unknown_model_id",
            },
        ];
    }

    if (projectPref !== null) {
        policy.projectOverride = projectPref;
        const validated = resolveModel(projectPref, "");
        if (validated) {
            policy.source = "project";
            policy.resolvedModel = validated;
            return { model: validated, policy };
        }
        policy.rejected = [
            ...(policy.rejected ?? []),
            {
                layer: "project",
                id: ctx.projectId ?? "",
                modelPreference: projectPref,
                reason: "unknown_model_id",
            },
        ];
    }

    return { model: requestedModel, policy };
}
