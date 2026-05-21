import { describe, it, expect } from "vitest";
import { extractNumbers } from "../../../src/lib/extractors/numbers";

describe("extractNumbers", () => {
    it("extracts symbol-prefixed currency with scale", () => {
        const out = extractNumbers("Revenue was $4.2 million in Q3.");
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            text: "$4.2 million",
            value: 4_200_000,
            kind: "currency",
            currency: "USD",
            scaleWord: "million",
            negative: false,
        });
        expect(out[0].offset).toBe("Revenue was ".length);
    });

    it("extracts thousands-separated currency without scale", () => {
        const out = extractNumbers("Total: $1,234,567.89");
        expect(out).toHaveLength(1);
        expect(out[0].value).toBeCloseTo(1_234_567.89);
        expect(out[0].currency).toBe("USD");
        expect(out[0].scaleWord).toBeNull();
    });

    it("normalizes M/MM/B/bn abbreviations", () => {
        const out = extractNumbers("EBITDA $50M; revenue $1.5bn; AR $250MM");
        expect(out.map((m) => m.value)).toEqual([
            50_000_000,
            1_500_000_000,
            250_000_000,
        ]);
    });

    it("extracts percentages as decimal fractions", () => {
        const out = extractNumbers("Margin improved to 12.5% from 8 percent.");
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ value: 0.125, kind: "percent" });
        expect(out[1]).toMatchObject({ value: 0.08, kind: "percent" });
    });

    it("handles parenthesized negatives, currency-aware", () => {
        const out = extractNumbers("Net loss of ($1.2 million) for the period.");
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            value: -1_200_000,
            kind: "currency",
            currency: "USD",
            negative: true,
        });
    });

    it("extracts code-prefixed currency (USD 4.2 million)", () => {
        const out = extractNumbers("Reported revenue of USD 4.2 million.");
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            value: 4_200_000,
            currency: "USD",
            scaleWord: "million",
        });
    });

    it("does not double-extract overlapping spans", () => {
        // The "4.2 million" inside "$4.2 million" must not also surface as a bare match.
        const out = extractNumbers("Revenue was $4.2 million.");
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe("$4.2 million");
    });

    it("ignores bare numbers without scale or unit", () => {
        const out = extractNumbers("On page 12, see exhibit 4 from 2024.");
        expect(out).toHaveLength(0);
    });

    it("extracts bare scale-suffixed numbers", () => {
        const out = extractNumbers("Synergies of 250 million were realized.");
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            value: 250_000_000,
            kind: "bare",
            scaleWord: "million",
        });
    });

    it("returns matches sorted by offset", () => {
        const out = extractNumbers("$10M and 5% and €20 million");
        expect(out.map((m) => m.offset)).toEqual(
            [...out.map((m) => m.offset)].sort((a, b) => a - b),
        );
        expect(out.map((m) => m.kind)).toEqual([
            "currency",
            "percent",
            "currency",
        ]);
        expect(out[2].currency).toBe("EUR");
    });

    it("byte offsets quote back the exact source span", () => {
        const src = "Pre-tax income of $42.7M for FY24.";
        const out = extractNumbers(src);
        expect(out).toHaveLength(1);
        const m = out[0];
        expect(src.slice(m.offset, m.offset + m.length)).toBe(m.text);
    });
});
