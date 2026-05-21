import { describe, it, expect } from "vitest";
import { extractPeriods } from "../../../src/lib/extractors/periods";

describe("extractPeriods", () => {
    it("extracts FY2024", () => {
        const out = extractPeriods("For FY2024 we delivered record results.");
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            kind: "duration",
            start: "2024-01-01",
            end: "2024-12-31",
            key: "duration:2024-01-01..2024-12-31",
        });
    });

    it("expands two-digit FY24", () => {
        const out = extractPeriods("Adjusted EBITDA in FY24");
        expect(out[0].start).toBe("2024-01-01");
        expect(out[0].end).toBe("2024-12-31");
    });

    it("extracts Q3 2024", () => {
        const out = extractPeriods("Q3 2024 revenue was strong.");
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            start: "2024-07-01",
            end: "2024-09-30",
        });
    });

    it("extracts 'three months ended' duration", () => {
        const out = extractPeriods(
            "Revenue for the three months ended September 28, 2024 was $94.9B.",
        );
        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe("duration");
        expect(out[0].end).toBe("2024-09-28");
        // Three months back, plus one day to make it inclusive-start.
        expect(out[0].start).toBe("2024-06-29");
    });

    it("extracts 'year ended' duration", () => {
        const out = extractPeriods(
            "For the fiscal year ended December 31, 2023, net income was $5B.",
        );
        expect(out).toHaveLength(1);
        expect(out[0].end).toBe("2023-12-31");
        expect(out[0].start).toBe("2023-01-01");
    });

    it("extracts 'as of' as instant", () => {
        const out = extractPeriods("Cash and equivalents as of December 31, 2023.");
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            kind: "instant",
            end: "2023-12-31",
            key: "instant:2023-12-31",
        });
    });

    it("extracts written-out quarter", () => {
        const out = extractPeriods("During the third quarter of 2024 we shipped.");
        expect(out).toHaveLength(1);
        expect(out[0].start).toBe("2024-07-01");
        expect(out[0].end).toBe("2024-09-30");
    });

    it("does not double-extract overlapping spans", () => {
        // "three months ended September 28, 2024" should win over any FY pattern.
        const out = extractPeriods(
            "the three months ended September 28, 2024",
        );
        expect(out).toHaveLength(1);
    });

    it("byte offsets quote back the exact source span", () => {
        const src = "We saw growth in Q3 2024 and again in FY2024.";
        const out = extractPeriods(src);
        for (const m of out) {
            expect(src.slice(m.offset, m.offset + m.length)).toBe(m.text);
        }
    });
});
