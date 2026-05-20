// Phase 8: deterministic entity extractor.
//
// Combines two passes:
//   1. Gazetteer lookup — exact match against issuer names / tickers / CIKs
//      seeded from `edgar_facts`. This is the high-confidence path: if the
//      prose mentions "Apple Inc." and we already ingested an Apple filing,
//      the connection is trivial.
//   2. Suffix-based fallback — regex over Inc./Corp./LP/LLC/plc/Ltd
//      capitalized phrases. Surfaces issuers we haven't ingested yet so
//      Phase 11 connectors can lazily resolve them.
//
// Per CLAUDE.md: explainable thresholds, no LLM, byte offsets carried.

export interface GazetteerEntry {
    /** Canonical display name (e.g. "Apple Inc.") */
    name: string;
    /** Any alternate aliases that should resolve to the same canonical id. */
    aliases?: string[];
    /** Stable identifier — use CIK for EDGAR-seeded entities. */
    canonicalId: string;
    /** Ticker symbol if available — surfaced for exact-match too. */
    ticker?: string | null;
}

export type EntityMatchSource = "gazetteer" | "suffix";

export interface EntityMatch {
    text: string;
    offset: number;
    length: number;
    canonicalId: string | null;
    canonicalName: string;
    source: EntityMatchSource;
}

const COMPANY_SUFFIXES = [
    "Inc.",
    "Inc",
    "Incorporated",
    "Corp.",
    "Corp",
    "Corporation",
    "Company",
    "Co.",
    "LLC",
    "L.L.C.",
    "LP",
    "L.P.",
    "Ltd.",
    "Ltd",
    "Limited",
    "plc",
    "PLC",
    "N.V.",
    "S.A.",
    "AG",
    "GmbH",
    "SE",
];

// Capitalized-word run preceding a company suffix. Allows "&", internal
// hyphens, and lowercase connectors (of, the, and). Periods are NOT part
// of the run so the suffix's leading word boundary is reliable.
const CAPITAL_WORD = String.raw`(?:[A-Z][A-Za-z0-9&\-]*)`;
const CAPITAL_RUN = String.raw`${CAPITAL_WORD}(?:[,]?\s+(?:${CAPITAL_WORD}|of|the|and|de|du|la|le))*`;

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSuffixRegex(): RegExp {
    const suffixes = COMPANY_SUFFIXES.map(escapeRegex)
        .sort((a, b) => b.length - a.length)
        .join("|");
    // Trailing lookahead: suffix ends at whitespace, comma, period, end of
    // string, or another punctuation mark. `\b` doesn't fire reliably after
    // suffixes ending in `.` (e.g. "Corp.") so we don't rely on it.
    return new RegExp(`(${CAPITAL_RUN}),?\\s+(${suffixes})(?=\\s|$|[,;:.)])`, "g");
}

function buildGazetteerRegex(entries: GazetteerEntry[]): {
    re: RegExp;
    lookup: Map<string, GazetteerEntry>;
} | null {
    const lookup = new Map<string, GazetteerEntry>();
    const variants: string[] = [];
    for (const entry of entries) {
        const all = [entry.name, ...(entry.aliases ?? [])];
        if (entry.ticker) all.push(entry.ticker);
        for (const v of all) {
            if (!v) continue;
            const key = v.toLowerCase();
            if (!lookup.has(key)) {
                lookup.set(key, entry);
                variants.push(v);
            }
        }
    }
    if (variants.length === 0) return null;
    // Longest-first so "Apple Inc." beats "Apple".
    variants.sort((a, b) => b.length - a.length);
    const pattern = variants.map(escapeRegex).join("|");
    // No trailing \b — variants like "Apple Inc." end with `.` and \b
    // between `.` and ` ` doesn't fire. The lookahead enforces a clean break.
    return {
        re: new RegExp(`\\b(${pattern})(?=\\s|$|[,;:.)]|[^A-Za-z0-9])`, "g"),
        lookup,
    };
}

function pushUnique(
    out: EntityMatch[],
    claimed: Array<[number, number]>,
    m: EntityMatch,
): void {
    for (const [s, e] of claimed) {
        if (m.offset < e && m.offset + m.length > s) return;
    }
    claimed.push([m.offset, m.offset + m.length]);
    out.push(m);
}

/**
 * Extract company / issuer mentions from prose.
 *
 * Gazetteer pass runs first so high-confidence canonical matches lock out
 * the suffix pass — that prevents "Apple Inc." from also surfacing as a
 * separate suffix-only match with `canonicalId = null`.
 */
export function extractEntities(
    source: string,
    gazetteer: GazetteerEntry[] = [],
): EntityMatch[] {
    const out: EntityMatch[] = [];
    const claimed: Array<[number, number]> = [];

    const gaz = buildGazetteerRegex(gazetteer);
    if (gaz) {
        let m: RegExpExecArray | null;
        while ((m = gaz.re.exec(source)) !== null) {
            const hit = gaz.lookup.get(m[1].toLowerCase());
            if (!hit) continue;
            pushUnique(out, claimed, {
                text: m[1],
                offset: m.index,
                length: m[1].length,
                canonicalId: hit.canonicalId,
                canonicalName: hit.name,
                source: "gazetteer",
            });
        }
    }

    const suffixRe = buildSuffixRegex();
    let m: RegExpExecArray | null;
    while ((m = suffixRe.exec(source)) !== null) {
        const [whole] = m;
        pushUnique(out, claimed, {
            text: whole,
            offset: m.index,
            length: whole.length,
            canonicalId: null,
            canonicalName: whole,
            source: "suffix",
        });
    }

    out.sort((a, b) => a.offset - b.offset);
    return out;
}
