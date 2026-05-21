import { describe, it, expect } from "vitest";
import { compareToXbrl, compareToProse } from "../../src/lib/consistency/compare";
import type { FactTuple } from "../../src/lib/extractors/factTuples";
import type { XbrlFactRow } from "../../src/lib/consistency/compare";

function tuple(overrides: Partial<FactTuple> = {}): FactTuple {
    return {
        concept: "us-gaap:Revenues",
        conceptLabel: "Revenue",
        entityId: "0000320193",
        entityName: "Apple Inc.",
        periodKey: "duration:2024-06-29..2024-09-28",
        periodStart: "2024-06-29",
        periodEnd: "2024-09-28",
        valueNumeric: 94_900_000_000,
        valueText: "$94.9 billion",
        unit: "iso4217:USD",
        valueOffset: 30,
        valueLength: 13,
        citation: { offset: 12, length: 7, quote: "Revenue of $94.9 billion" },
        ...overrides,
    };
}

function xbrl(overrides: Partial<XbrlFactRow> = {}): XbrlFactRow {
    return {
        id: "f-1",
        documentId: "doc-xbrl",
        concept: "us-gaap:Revenues",
        valueNumeric: 94_930_000_000,
        valueText: "94930000000",
        unit: "iso4217:USD",
        periodStart: "2024-06-29",
        periodEnd: "2024-09-28",
        instant: null,
        decimals: -6,
        ...overrides,
    };
}

describe("compareToXbrl", () => {
    it("accepts values within rounding tolerance (no finding)", () => {
        const out = compareToXbrl([tuple()], "doc-prose", [xbrl()]);
        // $94.9B vs 94.93B is ~0.03% — within tolerance.
        expect(out).toEqual([]);
    });

    it("flags genuine mismatches outside tolerance", () => {
        const out = compareToXbrl(
            [tuple({ valueNumeric: 50_000_000_000 })],
            "doc-prose",
            [xbrl()],
        );
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe("mismatch");
        expect(out[0].right.kind).toBe("xbrl");
        expect(out[0].right.factId).toBe("f-1");
    });

    it("flags unit drift when values agree but units differ", () => {
        const out = compareToXbrl([tuple()], "doc-prose", [
            xbrl({ unit: "iso4217:EUR" }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe("unit_drift");
    });

    it("emits orphan when no XBRL fact matches concept+period", () => {
        const out = compareToXbrl(
            [tuple({ periodKey: "duration:2099-01-01..2099-12-31" })],
            "doc-prose",
            [xbrl()],
        );
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe("orphan");
    });

    it("respects decimals precision for tolerance", () => {
        // XBRL decimals=-6 → values to nearest million. A $400k difference
        // should be inside precision.
        const out = compareToXbrl(
            [
                tuple({
                    valueNumeric: 94_900_400_000,
                    valueText: "$94,900,400,000",
                }),
            ],
            "doc-prose",
            [xbrl({ valueNumeric: 94_900_000_000, decimals: -6 })],
        );
        expect(out).toEqual([]);
    });
});

describe("compareToProse", () => {
    it("flags differences between sibling docs", () => {
        const out = compareToProse(
            { documentId: "10-Q", tuples: [tuple({ valueNumeric: 94_900_000_000 })] },
            { documentId: "10-K", tuples: [tuple({ valueNumeric: 80_000_000_000 })] },
        );
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe("mismatch");
        expect(out[0].left.documentId).toBe("10-Q");
        expect(out[0].right.documentId).toBe("10-K");
        expect(out[0].right.kind).toBe("prose");
    });

    it("does not flag tuples that only exist on one side", () => {
        const out = compareToProse(
            { documentId: "A", tuples: [tuple()] },
            { documentId: "B", tuples: [] },
        );
        expect(out).toEqual([]);
    });

    it("matches across docs by entity+concept+period", () => {
        const out = compareToProse(
            {
                documentId: "A",
                tuples: [tuple({ entityId: "1", valueNumeric: 100 })],
            },
            {
                documentId: "B",
                tuples: [tuple({ entityId: "1", valueNumeric: 100 })],
            },
        );
        expect(out).toEqual([]);
    });
});
