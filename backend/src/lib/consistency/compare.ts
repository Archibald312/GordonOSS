// Phase 8: pure cross-doc consistency comparison.
//
// Two input modes:
//   - compareToXbrl(prose, xbrl)   — intra-doc check (10-K/10-Q prose vs.
//     its own XBRL instance facts)
//   - compareToProse(left, right)  — cross-doc check (e.g. Q3 10-Q vs.
//     FY 10-K for the same period)
//
// Output is a list of `Finding`. No DB, no LLM, no IO — persistence is
// done by the caller. Findings always carry both sides' byte offsets and
// quotes so the UI can render a side-by-side citation comparison.
//
// Equality tolerance: numeric values that differ by less than the XBRL
// `decimals` precision (or 0.5% of the smaller value, whichever is larger)
// are considered equal. This avoids spurious findings from rounding —
// prose says "$94.9 billion", XBRL says 94,930,000,000 (which is
// 94.93B), and we don't want to flag a 0.03% difference.

import type { FactTuple } from "../extractors/factTuples";

export type FindingSeverity = "mismatch" | "unit_drift" | "orphan";

export interface FindingSide {
    documentId: string | null;
    factId?: string | null;
    valueNumeric: number | null;
    valueText: string;
    unit: string | null;
    byteOffset: number | null;
    byteLength: number | null;
    quote: string;
}

export interface Finding {
    severity: FindingSeverity;
    entity: string | null;
    concept: string;
    periodKey: string;
    left: FindingSide;
    right: FindingSide & { kind: "xbrl" | "prose" };
    details: Record<string, unknown>;
}

export interface XbrlFactRow {
    /** Maps to edgar_facts.id. */
    id?: string | null;
    documentId: string;
    concept: string;
    valueNumeric: number | null;
    valueText: string;
    unit: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    instant: string | null;
    decimals: number | null;
}

function periodKeyOfXbrl(f: XbrlFactRow): string {
    if (f.instant) return `instant:${f.instant}`;
    if (f.periodStart && f.periodEnd)
        return `duration:${f.periodStart}..${f.periodEnd}`;
    return "unknown";
}

function valuesEqual(
    a: number,
    b: number,
    decimals: number | null,
): { equal: boolean; deltaPct: number } {
    if (a === b) return { equal: true, deltaPct: 0 };
    const denom = Math.max(Math.abs(a), Math.abs(b), 1);
    const delta = Math.abs(a - b);
    const deltaPct = delta / denom;
    // Pct tolerance: 0.5% covers prose-vs-XBRL rounding ("$94.9B" vs 94,930,000,000).
    if (deltaPct < 0.005) return { equal: true, deltaPct };
    // Decimals tolerance: XBRL decimals=-6 means values reported to the
    // nearest million. A delta smaller than 5×10^-decimals is within precision.
    if (decimals != null && decimals < 0) {
        const tol = 5 * Math.pow(10, -decimals - 1);
        if (delta <= tol) return { equal: true, deltaPct };
    }
    return { equal: false, deltaPct };
}

function unitsEqual(a: string | null, b: string | null): boolean {
    if (a == null || b == null) return true; // unknown unit on either side is permissive
    return a.toLowerCase() === b.toLowerCase();
}

function findingFromMismatch(
    tuple: FactTuple,
    leftDocumentId: string,
    rightSide: FindingSide & { kind: "xbrl" | "prose" },
    severity: FindingSeverity,
    details: Record<string, unknown>,
): Finding {
    return {
        severity,
        entity: tuple.entityId ?? tuple.entityName,
        concept: tuple.concept,
        periodKey: tuple.periodKey,
        left: {
            documentId: leftDocumentId,
            valueNumeric: tuple.valueNumeric,
            valueText: tuple.valueText,
            unit: tuple.unit,
            byteOffset: tuple.valueOffset,
            byteLength: tuple.valueLength,
            quote: tuple.citation.quote,
        },
        right: rightSide,
        details,
    };
}

/**
 * Compare prose-extracted FactTuples against XBRL facts from the same filing.
 *
 * For each prose tuple, find an XBRL fact matching (concept, periodKey).
 * If found:
 *   - values disagree              → "mismatch"
 *   - units disagree but values OK → "unit_drift"
 *   - both agree                   → no finding
 * If not found:
 *   - emit "orphan" (prose value with no XBRL counterpart) — useful as a
 *     low-severity informational signal; UI can hide by default.
 */
export function compareToXbrl(
    prose: FactTuple[],
    proseDocumentId: string,
    xbrl: XbrlFactRow[],
): Finding[] {
    const byKey = new Map<string, XbrlFactRow[]>();
    for (const f of xbrl) {
        const key = `${f.concept}|${periodKeyOfXbrl(f)}`;
        const list = byKey.get(key) ?? [];
        list.push(f);
        byKey.set(key, list);
    }

    const out: Finding[] = [];
    for (const t of prose) {
        const candidates = byKey.get(`${t.concept}|${t.periodKey}`) ?? [];
        if (candidates.length === 0) {
            // Orphan — only emit if value is non-trivial (skip near-zero).
            if (Math.abs(t.valueNumeric) < 1) continue;
            out.push(
                findingFromMismatch(
                    t,
                    proseDocumentId,
                    {
                        kind: "xbrl",
                        documentId: null,
                        factId: null,
                        valueNumeric: null,
                        valueText: "",
                        unit: null,
                        byteOffset: null,
                        byteLength: null,
                        quote: "",
                    },
                    "orphan",
                    { reason: "no_xbrl_fact_for_concept_period" },
                ),
            );
            continue;
        }
        // Pick the best-matching XBRL row by unit equality first, then by
        // closeness in numeric value.
        const fact =
            candidates.find((c) => unitsEqual(c.unit, t.unit)) ?? candidates[0];
        if (fact.valueNumeric == null || !Number.isFinite(t.valueNumeric)) {
            continue;
        }
        const cmp = valuesEqual(t.valueNumeric, fact.valueNumeric, fact.decimals);
        const unitOk = unitsEqual(fact.unit, t.unit);
        if (cmp.equal && unitOk) continue;
        const severity: FindingSeverity = !cmp.equal ? "mismatch" : "unit_drift";
        out.push(
            findingFromMismatch(
                t,
                proseDocumentId,
                {
                    kind: "xbrl",
                    documentId: fact.documentId,
                    factId: fact.id ?? null,
                    valueNumeric: fact.valueNumeric,
                    valueText: fact.valueText,
                    unit: fact.unit,
                    byteOffset: null,
                    byteLength: null,
                    quote: `${fact.concept} = ${fact.valueText}${fact.unit ? ` ${fact.unit}` : ""}`,
                },
                severity,
                {
                    delta: fact.valueNumeric - t.valueNumeric,
                    delta_pct: cmp.deltaPct,
                    decimals: fact.decimals,
                },
            ),
        );
    }
    return out;
}

/**
 * Compare prose tuples from two different documents. Matches by
 * (entityId|entityName, concept, periodKey). Useful for spotting
 * restatements or transcription drift between sibling filings.
 *
 * Only emits "mismatch" / "unit_drift" — orphans don't make sense across
 * sibling docs (the absent side may simply not have covered that concept).
 */
export function compareToProse(
    left: { tuples: FactTuple[]; documentId: string },
    right: { tuples: FactTuple[]; documentId: string },
): Finding[] {
    const indexRight = new Map<string, FactTuple>();
    for (const t of right.tuples) {
        const ent = t.entityId ?? t.entityName ?? "*";
        indexRight.set(`${ent}|${t.concept}|${t.periodKey}`, t);
    }

    const out: Finding[] = [];
    for (const t of left.tuples) {
        const ent = t.entityId ?? t.entityName ?? "*";
        const counterpart = indexRight.get(`${ent}|${t.concept}|${t.periodKey}`);
        if (!counterpart) continue;
        const cmp = valuesEqual(t.valueNumeric, counterpart.valueNumeric, null);
        const unitOk = unitsEqual(t.unit, counterpart.unit);
        if (cmp.equal && unitOk) continue;
        out.push({
            severity: !cmp.equal ? "mismatch" : "unit_drift",
            entity: t.entityId ?? t.entityName,
            concept: t.concept,
            periodKey: t.periodKey,
            left: {
                documentId: left.documentId,
                valueNumeric: t.valueNumeric,
                valueText: t.valueText,
                unit: t.unit,
                byteOffset: t.valueOffset,
                byteLength: t.valueLength,
                quote: t.citation.quote,
            },
            right: {
                kind: "prose",
                documentId: right.documentId,
                factId: null,
                valueNumeric: counterpart.valueNumeric,
                valueText: counterpart.valueText,
                unit: counterpart.unit,
                byteOffset: counterpart.valueOffset,
                byteLength: counterpart.valueLength,
                quote: counterpart.citation.quote,
            },
            details: {
                delta: counterpart.valueNumeric - t.valueNumeric,
                delta_pct: cmp.deltaPct,
            },
        });
    }
    return out;
}
