import { describe, it, expect, vi } from "vitest";
import { EdgarClient } from "../../src/lib/connectors/edgar/client";

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

describe("EdgarClient", () => {
    it("requires a User-Agent containing an email", () => {
        expect(() => new EdgarClient({ userAgent: "Gordon" })).toThrow(
            /EDGAR_USER_AGENT/,
        );
    });

    it("looks up a ticker and returns padded CIK", async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse({
                "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
                "1": { cik_str: 789019, ticker: "MSFT", title: "Microsoft Corp" },
            }),
        ) as unknown as typeof fetch;
        const client = new EdgarClient({
            userAgent: "GordonOSS test (test@example.com)",
            fetchImpl,
        });
        const out = await client.lookupByTicker("aapl");
        expect(out).toEqual({
            cik: "0000320193",
            ticker: "AAPL",
            name: "Apple Inc.",
        });
    });

    it("returns null for an unknown ticker", async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse({
                "0": { cik_str: 1, ticker: "FOO", title: "Foo" },
            }),
        ) as unknown as typeof fetch;
        const client = new EdgarClient({
            userAgent: "GordonOSS test (test@example.com)",
            fetchImpl,
        });
        expect(await client.lookupByTicker("bar")).toBeNull();
    });

    it("filters recent filings by form type and limit", async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse({
                filings: {
                    recent: {
                        accessionNumber: ["a-1", "a-2", "a-3", "a-4"],
                        form: ["10-K", "8-K", "10-Q", "10-K"],
                        filingDate: ["2024-11-01", "2024-10-01", "2024-09-01", "2023-11-01"],
                        reportDate: ["2024-09-28", "", "2024-06-29", "2023-09-30"],
                        primaryDocument: ["a.htm", "b.htm", "c.htm", "d.htm"],
                    },
                },
            }),
        ) as unknown as typeof fetch;
        const client = new EdgarClient({
            userAgent: "GordonOSS test (test@example.com)",
            fetchImpl,
        });
        const out = await client.getRecentFilings("320193", {
            formTypes: ["10-K"],
            limit: 5,
        });
        expect(out.map((f) => f.accession_number)).toEqual(["a-1", "a-4"]);
        // Pads CIK in the request URL.
        const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as string;
        expect(url).toContain("CIK0000320193.json");
    });

    it("sends the configured User-Agent on every request", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
        const client = new EdgarClient({
            userAgent: "GordonOSS test (ops@example.com)",
            fetchImpl,
        });
        await client.lookupByTicker("AAPL").catch(() => null);
        const headers = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0][1].headers as Record<string, string>;
        expect(headers["User-Agent"]).toBe(
            "GordonOSS test (ops@example.com)",
        );
    });
});
