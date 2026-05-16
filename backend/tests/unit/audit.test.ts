import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hashContent, recordAudit, type AuditEntry } from "../../src/lib/audit";

function makeDb(insertImpl?: (row: unknown) => { error: unknown }) {
    const insertedRows: unknown[] = [];
    const insert = vi.fn(async (row: unknown) => {
        insertedRows.push(row);
        return insertImpl ? insertImpl(row) : { error: null };
    });
    const from = vi.fn(() => ({ insert }));
    return { db: { from } as never, insert, insertedRows };
}

const baseEntry: AuditEntry = {
    eventType: "tool_call",
    userId: "11111111-1111-1111-1111-111111111111",
    toolName: "read_document",
    status: "success",
};

beforeEach(() => {
    delete process.env.AUDIT_LOG_ENABLED;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("hashContent", () => {
    it("is deterministic for the same input", () => {
        expect(hashContent("hello")).toBe(hashContent("hello"));
    });

    it("differs for different inputs", () => {
        expect(hashContent("a")).not.toBe(hashContent("b"));
    });

    it("returns a 64-char hex string", () => {
        const out = hashContent("anything");
        expect(out).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("recordAudit", () => {
    it("inserts a row with the expected shape", async () => {
        const { db, insert, insertedRows } = makeDb();
        await recordAudit(
            {
                ...baseEntry,
                userEmail: "u@example.com",
                projectId: "22222222-2222-2222-2222-222222222222",
                documentIds: ["33333333-3333-3333-3333-333333333333"],
                inputHash: hashContent("in"),
                outputHash: hashContent("out"),
                durationMs: 42,
            },
            db,
        );
        expect(insert).toHaveBeenCalledTimes(1);
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.event_type).toBe("tool_call");
        expect(row.user_id).toBe(baseEntry.userId);
        expect(row.user_email).toBe("u@example.com");
        expect(row.tool_name).toBe("read_document");
        expect(row.project_id).toBe("22222222-2222-2222-2222-222222222222");
        expect(row.document_ids).toEqual([
            "33333333-3333-3333-3333-333333333333",
        ]);
        expect(row.duration_ms).toBe(42);
        expect(row.status).toBe("success");
    });

    it("is a no-op when AUDIT_LOG_ENABLED is false", async () => {
        process.env.AUDIT_LOG_ENABLED = "false";
        const { db, insert } = makeDb();
        await recordAudit(baseEntry, db);
        expect(insert).not.toHaveBeenCalled();
    });

    it("swallows insert errors without throwing", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { db } = makeDb(() => ({ error: { message: "boom" } }));
        await expect(recordAudit(baseEntry, db)).resolves.toBeUndefined();
        expect(errSpy).toHaveBeenCalled();
    });

    it("nulls out empty optional arrays", async () => {
        const { db, insertedRows } = makeDb();
        await recordAudit(baseEntry, db);
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.document_ids).toBeNull();
        expect(row.source_license_scopes).toBeNull();
        expect(row.user_email).toBeNull();
    });
});
