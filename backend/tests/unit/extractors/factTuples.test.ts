import { describe, it, expect } from "vitest";
import { buildFactTuples } from "../../../src/lib/extractors/factTuples";

describe("buildFactTuples", () => {
    it("composes a revenue tuple from a single sentence", () => {
        const src =
            "Apple Inc. reported revenue of $94.9 billion for the three months ended September 28, 2024.";
        const tuples = buildFactTuples(src, {
            gazetteer: [
                { canonicalId: "0000320193", name: "Apple Inc.", ticker: "AAPL" },
            ],
        });
        expect(tuples).toHaveLength(1);
        expect(tuples[0]).toMatchObject({
            concept: "us-gaap:Revenues",
            entityId: "0000320193",
            entityName: "Apple Inc.",
            valueNumeric: 94_900_000_000,
            unit: "iso4217:USD",
            periodEnd: "2024-09-28",
            periodStart: "2024-06-29",
        });
    });

    it("composes a percentage tuple", () => {
        const src = "Gross profit margin for FY2024 was 45.5%.";
        const tuples = buildFactTuples(src);
        // Gross profit anchor with 45.5% as nearest value.
        expect(tuples).toHaveLength(1);
        expect(tuples[0]).toMatchObject({
            concept: "us-gaap:GrossProfit",
            valueNumeric: 0.455,
            unit: "xbrli:pure",
            periodKey: "duration:2024-01-01..2024-12-31",
        });
    });

    it("drops anchors without a nearby number", () => {
        const src = "Revenue is discussed below. See note 5 for details.";
        const tuples = buildFactTuples(src);
        expect(tuples).toEqual([]);
    });

    it("drops anchors without a period", () => {
        const src = "Revenue was $4.2 million.";
        const tuples = buildFactTuples(src);
        expect(tuples).toEqual([]);
    });

    it("emits one tuple per concept-period pair across a paragraph", () => {
        const src = [
            "For FY2024, Acme Corp. reported revenue of $1.5 billion and net income of $200 million.",
        ].join(" ");
        const tuples = buildFactTuples(src);
        const concepts = tuples.map((t) => t.concept).sort();
        expect(concepts).toContain("us-gaap:Revenues");
        expect(concepts).toContain("us-gaap:NetIncomeLoss");
        const rev = tuples.find((t) => t.concept === "us-gaap:Revenues");
        const ni = tuples.find((t) => t.concept === "us-gaap:NetIncomeLoss");
        expect(rev?.valueNumeric).toBe(1_500_000_000);
        expect(ni?.valueNumeric).toBe(200_000_000);
    });

    it("rejects table-row matches with too many intervening numbers", () => {
        // A line that looks like a smushed table row from PDF extraction.
        // Net income is sandwiched between adjacent column values; the
        // sentence-guard should drop this rather than mis-attribute one.
        const src =
            "For FY2024, 39 129 25,126 (1) 25,125 Net income — — — 2,181";
        const tuples = buildFactTuples(src);
        expect(tuples).toEqual([]);
    });

    it("rejects matches that cross a newline boundary", () => {
        const src = "Revenue $4.2 million\nNet income for FY2024 was reported.";
        const tuples = buildFactTuples(src);
        // The number "$4.2 million" sits on a different line than "Net income"
        // so it must not be attributed to NetIncomeLoss.
        const ni = tuples.find((t) => t.concept === "us-gaap:NetIncomeLoss");
        expect(ni).toBeUndefined();
    });

    it("citation quote contains both the concept and the value", () => {
        const src = "EBITDA for FY2024 totaled $50 million.";
        const tuples = buildFactTuples(src);
        expect(tuples).toHaveLength(1);
        const t = tuples[0];
        expect(t.citation.quote).toMatch(/EBITDA/);
        expect(t.citation.quote).toMatch(/\$50 million/);
    });
});
