import { describe, it, expect } from "vitest";
import { extractEntities } from "../../../src/lib/extractors/entities";

describe("extractEntities", () => {
    it("matches gazetteer entries by canonical name", () => {
        const out = extractEntities("Apple Inc. reported record revenue.", [
            { canonicalId: "0000320193", name: "Apple Inc.", ticker: "AAPL" },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            text: "Apple Inc.",
            canonicalId: "0000320193",
            canonicalName: "Apple Inc.",
            source: "gazetteer",
        });
    });

    it("matches tickers", () => {
        const out = extractEntities("AAPL is up today.", [
            { canonicalId: "0000320193", name: "Apple Inc.", ticker: "AAPL" },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].canonicalId).toBe("0000320193");
        expect(out[0].text).toBe("AAPL");
    });

    it("falls back to suffix detection when not in gazetteer", () => {
        const out = extractEntities("Acme Holdings Corp. is a private issuer.", []);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            text: "Acme Holdings Corp.",
            canonicalId: null,
            source: "suffix",
        });
    });

    it("gazetteer match suppresses overlapping suffix match", () => {
        const out = extractEntities("Apple Inc. reported revenue.", [
            { canonicalId: "0000320193", name: "Apple Inc." },
        ]);
        // Only one match — the gazetteer match — even though "Apple Inc."
        // would also match the suffix regex.
        expect(out).toHaveLength(1);
        expect(out[0].source).toBe("gazetteer");
    });

    it("prefers the longest gazetteer variant", () => {
        const out = extractEntities("Berkshire Hathaway Inc. holdings", [
            { canonicalId: "1067983", name: "Berkshire Hathaway Inc." },
            { canonicalId: "9999999", name: "Berkshire" },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].canonicalId).toBe("1067983");
    });

    it("byte offsets quote back the exact source span", () => {
        const src = "On filing, Acme Holdings Corp. reported.";
        const out = extractEntities(src, []);
        expect(out).toHaveLength(1);
        const m = out[0];
        expect(src.slice(m.offset, m.offset + m.length)).toBe(m.text);
    });

    it("handles multiple suffixes in the same string", () => {
        const out = extractEntities(
            "Goldman Sachs Group, Inc. advised Acme Co. on the deal.",
            [],
        );
        expect(out.length).toBeGreaterThanOrEqual(1);
        const names = out.map((m) => m.text);
        expect(names).toContain("Acme Co.");
    });
});
