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
// the value of that fact. 80 covers "Revenue was $4.2 million" through
// "Revenue for the quarter totaled $4.2 million" without picking up
// adjacent unrelated values. Phase 8 retuned down from 120 after we saw
// table-row false positives where columns smushed into one PDF text line.
const VALUE_WINDOW_CHARS = 80;
// Periods can sit further from the anchor — "for FY2024, revenue was..."
// — so we widen the window. Still bounded to avoid sentence-spanning grabs.
const PERIOD_WINDOW_CHARS = 200;
const ENTITY_WINDOW_CHARS = 500;
// Tabular guard: when a PDF table row gets extracted as a single line, the
// concept anchor ("Net income") sits next to many adjacent column values.
// Picking the literal "nearest" number then attributes column-1 numbers to
// the row label. If this many *other* extracted numbers sit between the
// anchor and the chosen candidate, the candidate is probably from a
// different column and we drop the tuple.
const MAX_INTERVENING_NUMBERS = 0;

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

/**
 * Reject the (anchor, candidate-number) pair if the gap between them looks
 * like a table row rather than a sentence:
 *   - a newline character indicates a column / row break
 *   - more than MAX_INTERVENING_NUMBERS other numeric tokens between the
 *     anchor's center and the candidate's span suggests the candidate is
 *     from a different column in the same row
 *
 * Returns true if the pair is plausible (sentence-like proximity).
 */
// Matches "table-row shaped" numeric tokens — comma-grouped thousands or
// values with a decimal. Deliberately excludes plain 1-4 digit integers
// because those false-positive on years (FY2024 ⇒ "2024") and on small
// counts ("note 5", "page 12"). Currency parens-negatives like "(1,234)"
// are matched via the comma-grouped variant.
const ANY_NUMBER_TOKEN = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+\.\d+/g;

function passesSentenceGuard(
    source: string,
    anchorCenter: number,
    candidate: { offset: number; length: number },
    _allNumbers: Array<{ offset: number; length: number }>,
): boolean {
    const lo = Math.min(anchorCenter, candidate.offset);
    const hi = Math.max(anchorCenter, candidate.offset + candidate.length);
    const between = source.slice(lo, hi);
    if (between.includes("\n")) return false;
    // Count number-shaped tokens that don't overlap the candidate itself.
    const re = new RegExp(ANY_NUMBER_TOKEN.source, "g");
    let intervening = 0;
    let m: RegExpExecArray | null;
    const candStartLocal = candidate.offset - lo;
    const candEndLocal = candStartLocal + candidate.length;
    while ((m = re.exec(between)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        // Skip tokens that overlap the chosen candidate's span.
        if (start < candEndLocal && end > candStartLocal) continue;
        intervening++;
        if (intervening > MAX_INTERVENING_NUMBERS) return false;
    }
    return true;
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
            if (!passesSentenceGuard(source, center, num, numbers)) continue;
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
