// Phase 8: deterministic numeric extractor.
//
// Scans prose for currency amounts, percentages, and scale-suffixed values.
// Every match carries its byte offset and length so a downstream citation
// can quote the exact span. No LLM in the hot path — per CLAUDE.md, the
// citation IS the product, and a regex match has a provable origin.
//
// Output is a flat list of `NumberMatch`. Callers compose these with periods
// and entities in `factTuples.ts` to build cross-doc consistency tuples.

export type NumberKind = "currency" | "percent" | "bare";

export interface NumberMatch {
    /** Verbatim source text of the match (e.g. "$4.2 million", "12.5%"). */
    text: string;
    /** UTF-16 character offset into the source string (matches Buffer-of-utf8 positions for ASCII; document this if/when non-ASCII matters). */
    offset: number;
    /** Length in source characters. */
    length: number;
    /** Numeric value after scale normalization (e.g. "$4.2M" → 4_200_000, "12.5%" → 0.125). */
    value: number;
    kind: NumberKind;
    /** Currency code (ISO 4217) if a sign / code was present. Null for percentages and bare numbers. */
    currency: string | null;
    /** Scale word actually present in the source ("million", "billion", "thousand", "trillion") or null. */
    scaleWord: string | null;
    /** True if the literal had a leading "(" / trailing ")" or a leading "-". */
    negative: boolean;
}

const SCALE_FACTORS: Record<string, number> = {
    thousand: 1_000,
    k: 1_000,
    million: 1_000_000,
    m: 1_000_000,
    mm: 1_000_000,
    billion: 1_000_000_000,
    bn: 1_000_000_000,
    b: 1_000_000_000,
    trillion: 1_000_000_000_000,
    t: 1_000_000_000_000,
};

// Currency symbols → ISO 4217. Kept tight on purpose: anything outside this
// list is treated as a bare number rather than guessed.
const CURRENCY_SYMBOLS: Record<string, string> = {
    $: "USD",
    "€": "EUR",
    "£": "GBP",
    "¥": "JPY",
};

const CURRENCY_CODES = new Set([
    "USD",
    "EUR",
    "GBP",
    "JPY",
    "CAD",
    "AUD",
    "CHF",
    "CNY",
    "HKD",
    "SGD",
    "INR",
]);

// Bare number with optional sign, thousands separators, optional decimal.
// Anchored at the outer matcher; the inner captures are reused everywhere.
const NUM_BODY = String.raw`-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?`;

// Parenthesized negative literals: "(1,234)" → -1234. Currency-prefixed too.
const PAREN_NEG_BODY = String.raw`\(\s*[\$€£¥]?\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*\)`;

const SCALE_WORD = String.raw`(?:thousand|million|billion|trillion|mm|bn|[KkMmBbTt])`;

function parseBareNumber(raw: string): number | null {
    const cleaned = raw.replace(/[,\s]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
}

function normalizeScaleWord(raw: string | undefined): string | null {
    if (!raw) return null;
    const lower = raw.toLowerCase();
    return lower in SCALE_FACTORS ? lower : null;
}

function applyScale(base: number, scaleWord: string | null): number {
    if (!scaleWord) return base;
    const factor = SCALE_FACTORS[scaleWord];
    return factor ? base * factor : base;
}

function pushMatchUnique(
    out: NumberMatch[],
    claimed: Array<[number, number]>,
    m: NumberMatch,
): void {
    // Skip if this match's span overlaps an already-claimed (higher-priority) span.
    for (const [start, end] of claimed) {
        if (m.offset < end && m.offset + m.length > start) return;
    }
    claimed.push([m.offset, m.offset + m.length]);
    out.push(m);
}

/**
 * Extract numeric mentions from a plain-text body.
 *
 * Pipeline (highest priority first; earlier matches lock out their span):
 *   1. Parenthesized currency negatives — "($1,234)", "($4.2 million)"
 *   2. Currency-prefixed values         — "$4.2M", "USD 1,500 million"
 *   3. Percentages                       — "12.5%", "12.5 percent"
 *   4. Bare scale-suffixed numbers      — "4.2 million", "1.5bn"
 *
 * Bare numbers without a scale or unit are NOT extracted — they're too noisy
 * (years, exhibit numbers, page numbers). Phase 11 finance workflows can add
 * a context-aware bare-number pass if a use case demands it.
 */
export function extractNumbers(source: string): NumberMatch[] {
    const out: NumberMatch[] = [];
    const claimed: Array<[number, number]> = [];

    // 1. Parenthesized negatives, currency-aware.
    {
        const re = new RegExp(
            String.raw`\(\s*([\$€£¥])?\s*(${NUM_BODY})\s*(${SCALE_WORD})?\s*\)`,
            "g",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, sym, body, scale] = m;
            const base = parseBareNumber(body);
            if (base == null) continue;
            const scaleWord = normalizeScaleWord(scale);
            const value = -Math.abs(applyScale(base, scaleWord));
            pushMatchUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                value,
                kind: sym ? "currency" : "bare",
                currency: sym ? CURRENCY_SYMBOLS[sym] ?? null : null,
                scaleWord,
                negative: true,
            });
        }
    }

    // 2a. Symbol-prefixed currency.
    {
        const re = new RegExp(
            String.raw`(-)?([\$€£¥])\s?(${NUM_BODY})(?:\s*(${SCALE_WORD}))?`,
            "g",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, neg, sym, body, scale] = m;
            const base = parseBareNumber(body);
            if (base == null) continue;
            const scaleWord = normalizeScaleWord(scale);
            const signed = neg ? -Math.abs(base) : base;
            const value = applyScale(signed, scaleWord);
            pushMatchUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                value,
                kind: "currency",
                currency: CURRENCY_SYMBOLS[sym] ?? null,
                scaleWord,
                negative: neg != null || value < 0,
            });
        }
    }

    // 2b. Code-prefixed currency ("USD 4.2 million", "EUR 1,500").
    {
        const re = new RegExp(
            String.raw`\b(USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|HKD|SGD|INR)\s+(-)?(${NUM_BODY})(?:\s*(${SCALE_WORD}))?`,
            "g",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, code, neg, body, scale] = m;
            if (!CURRENCY_CODES.has(code)) continue;
            const base = parseBareNumber(body);
            if (base == null) continue;
            const scaleWord = normalizeScaleWord(scale);
            const signed = neg ? -Math.abs(base) : base;
            const value = applyScale(signed, scaleWord);
            pushMatchUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                value,
                kind: "currency",
                currency: code,
                scaleWord,
                negative: neg != null || value < 0,
            });
        }
    }

    // 3. Percentages: "12.5%", "12.5 percent".
    {
        const re = new RegExp(
            String.raw`(-)?(${NUM_BODY})\s?(?:%|percent\b)`,
            "g",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, neg, body] = m;
            const base = parseBareNumber(body);
            if (base == null) continue;
            const signed = neg ? -Math.abs(base) : base;
            pushMatchUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                // Stored as a decimal fraction (12.5% → 0.125) so downstream
                // math compares apples to apples regardless of source format.
                value: signed / 100,
                kind: "percent",
                currency: null,
                scaleWord: null,
                negative: neg != null,
            });
        }
    }

    // 4. Bare scale-suffixed numbers ("4.2 million", "1.5bn").
    {
        const re = new RegExp(
            String.raw`(-)?(${NUM_BODY})\s*(${SCALE_WORD})\b`,
            "g",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, neg, body, scale] = m;
            const base = parseBareNumber(body);
            if (base == null) continue;
            const scaleWord = normalizeScaleWord(scale);
            if (!scaleWord) continue;
            const signed = neg ? -Math.abs(base) : base;
            pushMatchUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                value: applyScale(signed, scaleWord),
                kind: "bare",
                currency: null,
                scaleWord,
                negative: neg != null,
            });
        }
    }

    out.sort((a, b) => a.offset - b.offset);
    return out;
}
