// Phase 8: compose numbers + periods + entities into FactTuples.
//
// A FactTuple is the unit of cross-doc comparison:
//   (entity, concept, period, value, unit, citation)
//
// The composer scans prose for known concept anchors (revenue, EBITDA,
// net income, etc.), then attaches the *nearest* number, period, and
// entity match by byte-offset proximity. Tuples without a nearby number
// or period are dropped — they lack the structure needed for comparison.
//
// "Concept" intentionally mirrors XBRL concept names (us-gaap:Revenues,
// us-gaap:NetIncomeLoss, etc.) so the consistency engine can match prose
// tuples 1-1 against edgar_facts rows without an additional mapping step.
//
// Per CLAUDE.md: pure code, byte offsets preserved on every side,
// proximity windows explainable, no LLM in the hot path.

import { extractNumbers, type NumberMatch } from "./numbers";
import { extractPeriods, type PeriodMatch } from "./periods";
import { extractEntities, type EntityMatch, type GazetteerEntry } from "./entities";

export interface FactTupleCitation {
    /** Byte offset of the concept anchor (the noun phrase that named the fact). */
    offset: number;
    length: number;
    /** Verbatim source slice surrounding the anchor (anchor + nearest number). */
    quote: string;
}

export interface FactTuple {
    /** Canonical XBRL-style concept (e.g. "us-gaap:Revenues"). */
    concept: string;
    /** Display label as it appeared in prose. */
    conceptLabel: string;
    /** Canonical entity id (CIK if gazetteer-matched) or null for unresolved. */
    entityId: string | null;
    entityName: string | null;
    /** Canonical period key — joins to extractors/periods PeriodMatch.key. */
    periodKey: string;
    periodStart: string | null;
    periodEnd: string;
    /** Normalized value (scale-applied, percentages as decimal fractions). */
    valueNumeric: number;
    /** Verbatim text of the matched number. */
    valueText: string;
    unit: string | null;
    citation: FactTupleCitation;
    /** Byte offset + length of the number span — useful for click-to-cite UIs. */
    valueOffset: number;
    valueLength: number;
}

// Concept anchors: aliases → canonical XBRL concept. Kept tight; Phase 11
// finance workflows will extend this for workflow-specific concepts.
const CONCEPT_ANCHORS: Array<{
    canonical: string;
    aliases: RegExp;
}> = [
    {
        canonical: "us-gaap:Revenues",
        aliases: /\b(?:revenue|revenues|net\s+sales|total\s+revenue)\b/gi,
    },
    {
        canonical: "us-gaap:NetIncomeLoss",
        aliases: /\b(?:net\s+income|net\s+loss|net\s+earnings)\b/gi,
    },
    {
        canonical: "us-gaap:OperatingIncomeLoss",
        aliases: /\b(?:operating\s+income|operating\s+loss|income\s+from\s+operations)\b/gi,
    },
    {
        canonical: "us-gaap:GrossProfit",
        aliases: /\bgross\s+profit\b/gi,
    },
    {
        canonical: "non-gaap:EBITDA",
        aliases: /\b(?:adjusted\s+)?EBITDA\b/gi,
    },
    {
        canonical: "us-gaap:EarningsPerShareBasic",
        aliases: /\b(?:basic\s+)?(?:earnings|loss)\s+per\s+(?:basic\s+)?share\b/gi,
    },
    {
        canonical: "us-gaap:CashAndCashEquivalentsAtCarryingValue",
        aliases: /\bcash\s+and\s+(?:cash\s+)?equivalents\b/gi,
    },
    {
        canonical: "us-gaap:Assets",
        aliases: /\btotal\s+assets\b/gi,
    },
    {
        canonical: "us-gaap:Liabilities",
        aliases: /\btotal\s+liabilities\b/gi,
    },
    {
        canonical: "us-gaap:StockholdersEquity",
        aliases: /\b(?:total\s+)?stockholders[''']?\s+equity\b/gi,
    },
];

// Within this many characters of a concept anchor, a number is considered
// the value of that fact. 120 covers "Revenue was $4.2 million" through
// "Revenue for the quarter ... totaled $4.2 million" without picking up
// adjacent unrelated values.
const VALUE_WINDOW_CHARS = 120;
// Periods can sit further from the anchor — "for FY2024, revenue was..."
// — so we widen the window. Still bounded to avoid sentence-spanning grabs.
const PERIOD_WINDOW_CHARS = 200;
const ENTITY_WINDOW_CHARS = 500;

function nearest<T extends { offset: number; length: number }>(
    target: number,
    candidates: T[],
    maxDistance: number,
): T | null {
    let best: T | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
        const cEnd = c.offset + c.length;
        const dist =
            c.offset > target
                ? c.offset - target
                : cEnd < target
                  ? target - cEnd
                  : 0;
        if (dist <= maxDistance && dist < bestDist) {
            best = c;
            bestDist = dist;
        }
    }
    return best;
}

function unitFor(num: NumberMatch): string | null {
    if (num.kind === "currency") return num.currency ? `iso4217:${num.currency}` : null;
    if (num.kind === "percent") return "xbrli:pure";
    return null;
}

function buildQuote(source: string, start: number, end: number): string {
    const a = Math.max(0, start - 20);
    const b = Math.min(source.length, end + 20);
    return source.slice(a, b).replace(/\s+/g, " ").trim();
}

export interface BuildFactTuplesOptions {
    gazetteer?: GazetteerEntry[];
}

/**
 * Build fact-tuples from prose. Iterates over concept anchors, attaches
 * the nearest in-window number, period, and entity, and emits one tuple
 * per (concept, period) pair. Tuples without a number or a period are
 * dropped (they can't participate in cross-doc comparison).
 */
export function buildFactTuples(
    source: string,
    options: BuildFactTuplesOptions = {},
): FactTuple[] {
    const numbers = extractNumbers(source);
    const periods = extractPeriods(source);
    const entities = extractEntities(source, options.gazetteer ?? []);

    const out: FactTuple[] = [];
    const seen = new Set<string>(); // dedupe within a single source

    for (const anchor of CONCEPT_ANCHORS) {
        // Fresh regex copy because the source object carries `lastIndex` state.
        const re = new RegExp(anchor.aliases.source, anchor.aliases.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const anchorOffset = m.index;
            const anchorLen = m[0].length;
            const center = anchorOffset + anchorLen / 2;
            const num = nearest(center, numbers, VALUE_WINDOW_CHARS);
            if (!num) continue;
            const per = nearest(center, periods, PERIOD_WINDOW_CHARS);
            if (!per) continue;
            const ent = nearest(center, entities, ENTITY_WINDOW_CHARS);

            const dedupeKey = `${anchor.canonical}|${ent?.canonicalId ?? ent?.canonicalName ?? ""}|${per.key}|${num.value}|${num.offset}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            const quoteStart = Math.min(anchorOffset, num.offset);
            const quoteEnd = Math.max(anchorOffset + anchorLen, num.offset + num.length);

            out.push({
                concept: anchor.canonical,
                conceptLabel: m[0],
                entityId: ent?.canonicalId ?? null,
                entityName: ent?.canonicalName ?? null,
                periodKey: per.key,
                periodStart: per.start,
                periodEnd: per.end,
                valueNumeric: num.value,
                valueText: num.text,
                unit: unitFor(num),
                valueOffset: num.offset,
                valueLength: num.length,
                citation: {
                    offset: anchorOffset,
                    length: anchorLen,
                    quote: buildQuote(source, quoteStart, quoteEnd),
                },
            });
        }
    }

    out.sort((a, b) => a.citation.offset - b.citation.offset);
    return out;
}
