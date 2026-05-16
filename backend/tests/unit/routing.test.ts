import { describe, it, expect, vi } from "vitest";
import { resolveModelRouting } from "../../src/lib/llm/routing";

// `resolveModel(id, fallback)` accepts a model only if it's in the canonical
// ALL_MODELS set (see backend/src/lib/llm/models.ts). These tests stick to
// known IDs (claude-opus-4-7, claude-sonnet-4-6, etc.) for the happy paths
// and use a deliberate "totally-fake-model" string for rejection tests.

type DocsRow = { id: string; model_preference: string | null };
type ProjectRow = { model_preference: string | null };

function makeDb(opts: {
    docs?: DocsRow[];
    project?: ProjectRow | null;
    docsError?: string;
    projectError?: string;
}) {
    const docsSelector = {
        in: vi.fn(async () => ({
            data: opts.docsError ? null : (opts.docs ?? []),
            error: opts.docsError ? { message: opts.docsError } : null,
        })),
    };
    const projectSelector = {
        eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
                data: opts.projectError ? null : (opts.project ?? null),
                error: opts.projectError
                    ? { message: opts.projectError }
                    : null,
            })),
        })),
    };
    const from = vi.fn((table: string) => ({
        select: vi.fn(() =>
            table === "documents" ? docsSelector : projectSelector,
        ),
    }));
    return { from } as never;
}

describe("resolveModelRouting", () => {
    it("returns the requested model unchanged when there are no overrides", async () => {
        const db = makeDb({ docs: [], project: null });
        const out = await resolveModelRouting(
            {
                db,
                projectId: "p1",
                documentIds: ["d1", "d2"],
            },
            "claude-opus-4-7",
        );
        expect(out.model).toBe("claude-opus-4-7");
        expect(out.policy.source).toBe("request");
        expect(out.policy.resolvedModel).toBe("claude-opus-4-7");
        expect(out.policy.documentOverrides).toBeUndefined();
    });

    it("honors a document-level override", async () => {
        const db = makeDb({
            docs: [{ id: "d1", model_preference: "claude-sonnet-4-6" }],
        });
        const out = await resolveModelRouting(
            { db, documentIds: ["d1"] },
            "claude-opus-4-7",
        );
        expect(out.model).toBe("claude-sonnet-4-6");
        expect(out.policy.source).toBe("document");
        expect(out.policy.documentOverrides).toEqual([
            { documentId: "d1", modelPreference: "claude-sonnet-4-6" },
        ]);
    });

    it("records conflicts when documents disagree but still picks the first", async () => {
        const db = makeDb({
            docs: [
                { id: "d1", model_preference: "claude-sonnet-4-6" },
                { id: "d2", model_preference: "gpt-5.4-mini" },
            ],
        });
        const out = await resolveModelRouting(
            { db, documentIds: ["d1", "d2"] },
            "claude-opus-4-7",
        );
        expect(out.model).toBe("claude-sonnet-4-6");
        expect(out.policy.conflicts).toEqual([
            { documentId: "d2", modelPreference: "gpt-5.4-mini" },
        ]);
    });

    it("falls back to the project override when no document declares one", async () => {
        const db = makeDb({
            docs: [{ id: "d1", model_preference: null }],
            project: { model_preference: "claude-sonnet-4-6" },
        });
        const out = await resolveModelRouting(
            { db, projectId: "p1", documentIds: ["d1"] },
            "claude-opus-4-7",
        );
        expect(out.model).toBe("claude-sonnet-4-6");
        expect(out.policy.source).toBe("project");
        expect(out.policy.projectOverride).toBe("claude-sonnet-4-6");
    });

    it("rejects unknown model ids and walks down the precedence chain", async () => {
        const db = makeDb({
            docs: [
                { id: "d1", model_preference: "totally-fake-model" },
            ],
            project: { model_preference: "claude-sonnet-4-6" },
        });
        const out = await resolveModelRouting(
            { db, projectId: "p1", documentIds: ["d1"] },
            "claude-opus-4-7",
        );
        expect(out.model).toBe("claude-sonnet-4-6");
        expect(out.policy.source).toBe("project");
        expect(out.policy.rejected).toEqual([
            {
                layer: "document",
                id: "d1",
                modelPreference: "totally-fake-model",
                reason: "unknown_model_id",
            },
        ]);
    });

    it("falls back to the requested model when every stored preference is unknown", async () => {
        const db = makeDb({
            docs: [{ id: "d1", model_preference: "fake-A" }],
            project: { model_preference: "fake-B" },
        });
        const out = await resolveModelRouting(
            { db, projectId: "p1", documentIds: ["d1"] },
            "claude-opus-4-7",
        );
        expect(out.model).toBe("claude-opus-4-7");
        expect(out.policy.source).toBe("request");
        expect(out.policy.rejected?.length).toBe(2);
    });

    it("survives a documents-query error without throwing", async () => {
        const db = makeDb({
            docsError: "boom",
            project: { model_preference: "claude-sonnet-4-6" },
        });
        const out = await resolveModelRouting(
            { db, projectId: "p1", documentIds: ["d1"] },
            "claude-opus-4-7",
        );
        // Document lookup failed → no document overrides applied; project
        // still resolves normally.
        expect(out.model).toBe("claude-sonnet-4-6");
        expect(out.policy.source).toBe("project");
    });

    it("skips the documents query when no document ids are supplied", async () => {
        const db = makeDb({ project: { model_preference: null } });
        const out = await resolveModelRouting(
            { db, projectId: "p1" },
            "claude-opus-4-7",
        );
        expect(out.model).toBe("claude-opus-4-7");
        expect(out.policy.source).toBe("request");
    });
});
