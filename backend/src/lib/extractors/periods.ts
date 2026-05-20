// Phase 8: deterministic fiscal-period extractor.
//
// Finance prose talks about periods in a handful of canonical ways:
//   - "FY2024", "fiscal year 2024", "fiscal 2024"
//   - "Q3 2024", "third quarter of 2024", "Q3 FY24"
//   - "the three months ended September 28, 2024"
//   - "the year ended December 31, 2023"
//   - "as of December 31, 2023" (instant)
//
// We normalize all of these to a `PeriodKey` — a stable string that the
// consistency engine can compare 1-1 with XBRL period tuples. The key is
// either:
//   "duration:YYYY-MM-DD..YYYY-MM-DD"   (e.g. "duration:2024-01-01..2024-12-31")
//   "instant:YYYY-MM-DD"                (e.g. "instant:2023-12-31")
//
// Per CLAUDE.md: pure code, byte offsets preserved, no LLM. Ambiguous spans
// (e.g. "the quarter" without a year) are dropped, not guessed.

export type PeriodKind = "duration" | "instant";

export interface PeriodMatch {
    text: string;
    offset: number;
    length: number;
    kind: PeriodKind;
    /** ISO date for duration start (or null for instant matches). */
    start: string | null;
    /** ISO date for duration end (or the instant date itself). */
    end: string;
    /** Canonical key for cross-doc comparison. */
    key: string;
}

const MONTHS: Record<string, number> = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sep: 9, sept: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12,
};

const MONTH_ALT = Object.keys(MONTHS).join("|");

const QUARTER_WORDS: Record<string, number> = {
    first: 1, "1st": 1,
    second: 2, "2nd": 2,
    third: 3, "3rd": 3,
    fourth: 4, "4th": 4,
};

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function isoDate(y: number, m: number, d: number): string {
    return `${y}-${pad2(m)}-${pad2(d)}`;
}

function lastDayOfMonth(y: number, m: number): number {
    // m is 1-indexed; new Date(y, m, 0) returns the last day of month m.
    return new Date(y, m, 0).getDate();
}

function durationKey(start: string, end: string): string {
    return `duration:${start}..${end}`;
}

function instantKey(date: string): string {
    return `instant:${date}`;
}

/**
 * Best-effort parse for a written-out date like "September 28, 2024" or
 * "December 31, 2023". Returns ISO yyyy-mm-dd or null.
 */
function parseLongDate(monthName: string, day: string, year: string): string | null {
    const m = MONTHS[monthName.toLowerCase()];
    const d = Number.parseInt(day, 10);
    const y = Number.parseInt(year, 10);
    if (!m || !Number.isFinite(d) || !Number.isFinite(y)) return null;
    if (d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    return isoDate(y, m, d);
}

function pushUnique(
    out: PeriodMatch[],
    claimed: Array<[number, number]>,
    m: PeriodMatch,
): void {
    for (const [s, e] of claimed) {
        if (m.offset < e && m.offset + m.length > s) return;
    }
    claimed.push([m.offset, m.offset + m.length]);
    out.push(m);
}

function fiscalYearKey(year: number): string {
    return durationKey(`${year}-01-01`, `${year}-12-31`);
}

function calendarQuarterKey(year: number, quarter: number): string {
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const start = isoDate(year, startMonth, 1);
    const end = isoDate(year, endMonth, lastDayOfMonth(year, endMonth));
    return durationKey(start, end);
}

/**
 * Extract fiscal-period mentions from prose.
 *
 * Pipeline (earlier patterns lock out their spans):
 *   1. "the three/six/nine months ended <Month> <D>, <YYYY>"
 *   2. "the year ended <Month> <D>, <YYYY>"
 *   3. "as of <Month> <D>, <YYYY>"               → instant
 *   4. "Q[1-4] [FY]?YYYY", "[first|...] quarter of YYYY"
 *   5. "FY[YY|YYYY]", "fiscal [year] YYYY"
 */
export function extractPeriods(source: string): PeriodMatch[] {
    const out: PeriodMatch[] = [];
    const claimed: Array<[number, number]> = [];

    // 1. "<N> months ended <Month> <D>, <YYYY>"
    {
        const wordToN: Record<string, number> = {
            three: 3, six: 6, nine: 9, twelve: 12,
        };
        const re = new RegExp(
            String.raw`(?:the\s+)?(three|six|nine|twelve|\d{1,2})\s+months?\s+ended\s+(${MONTH_ALT})\s+(\d{1,2}),?\s+(\d{4})`,
            "gi",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, span, month, day, year] = m;
            const months = wordToN[span.toLowerCase()] ?? Number.parseInt(span, 10);
            const end = parseLongDate(month, day, year);
            if (!end || !Number.isFinite(months)) continue;
            // Start = end - months + 1 day. Day-precise — fiscal calendars
            // (Apple's 52/53-week year, anyone with a non-calendar FY) push
            // start dates around by a day or two; for matching purposes the
            // tuple (end, length) is what XBRL contexts also encode.
            const endDate = new Date(`${end}T00:00:00Z`);
            const startDate = new Date(endDate);
            startDate.setUTCMonth(startDate.getUTCMonth() - months);
            startDate.setUTCDate(startDate.getUTCDate() + 1);
            const start = startDate.toISOString().slice(0, 10);
            pushUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                kind: "duration",
                start,
                end,
                key: durationKey(start, end),
            });
        }
    }

    // 2. "the year ended <Month> <D>, <YYYY>"
    {
        const re = new RegExp(
            String.raw`(?:the\s+)?(?:fiscal\s+)?year\s+ended\s+(${MONTH_ALT})\s+(\d{1,2}),?\s+(\d{4})`,
            "gi",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, month, day, year] = m;
            const end = parseLongDate(month, day, year);
            if (!end) continue;
            // start = end - 1 year + 1 day
            const endDate = new Date(`${end}T00:00:00Z`);
            const startDate = new Date(endDate);
            startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
            startDate.setUTCDate(startDate.getUTCDate() + 1);
            const start = startDate.toISOString().slice(0, 10);
            pushUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                kind: "duration",
                start,
                end,
                key: durationKey(start, end),
            });
        }
    }

    // 3. "as of <Month> <D>, <YYYY>"
    {
        const re = new RegExp(
            String.raw`as\s+of\s+(${MONTH_ALT})\s+(\d{1,2}),?\s+(\d{4})`,
            "gi",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, month, day, year] = m;
            const d = parseLongDate(month, day, year);
            if (!d) continue;
            pushUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                kind: "instant",
                start: null,
                end: d,
                key: instantKey(d),
            });
        }
    }

    // 4a. "Q[1-4] [FY]?YYYY"
    {
        const re = /Q([1-4])\s*(?:FY)?\s*(\d{2,4})/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, q, y] = m;
            const year = y.length === 2 ? 2000 + Number.parseInt(y, 10) : Number.parseInt(y, 10);
            const quarter = Number.parseInt(q, 10);
            const startMonth = (quarter - 1) * 3 + 1;
            const endMonth = startMonth + 2;
            const start = isoDate(year, startMonth, 1);
            const end = isoDate(year, endMonth, lastDayOfMonth(year, endMonth));
            pushUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                kind: "duration",
                start,
                end,
                key: durationKey(start, end),
            });
        }
    }

    // 4b. "first|second|third|fourth quarter of YYYY"
    {
        const re = /(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\s+of\s+(\d{4})/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, qword, y] = m;
            const quarter = QUARTER_WORDS[qword.toLowerCase()];
            if (!quarter) continue;
            const year = Number.parseInt(y, 10);
            pushUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                kind: "duration",
                start: calendarQuarterKey(year, quarter).split("..")[0].replace("duration:", ""),
                end: calendarQuarterKey(year, quarter).split("..")[1],
                key: calendarQuarterKey(year, quarter),
            });
        }
    }

    // 5. "FY2024", "FY24", "fiscal year 2024", "fiscal 2024"
    {
        const re = /(?:\bFY\s*(\d{2,4})\b|\bfiscal\s+(?:year\s+)?(\d{4})\b)/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const [whole, y1, y2] = m;
            const yStr = y1 ?? y2;
            const year = yStr.length === 2 ? 2000 + Number.parseInt(yStr, 10) : Number.parseInt(yStr, 10);
            if (!Number.isFinite(year)) continue;
            pushUnique(out, claimed, {
                text: whole,
                offset: m.index,
                length: whole.length,
                kind: "duration",
                start: `${year}-01-01`,
                end: `${year}-12-31`,
                key: fiscalYearKey(year),
            });
        }
    }

    out.sort((a, b) => a.offset - b.offset);
    return out;
}
