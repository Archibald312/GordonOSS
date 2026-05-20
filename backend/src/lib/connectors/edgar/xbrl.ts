// Phase 7: XBRL instance-document parser.
//
// XBRL is a flat XML where each numeric fact looks like:
//   <us-gaap:Revenues contextRef="FD2024" unitRef="USD" decimals="-6">383285000000</us-gaap:Revenues>
//
// Each contextRef points to a <xbrli:context id="FD2024"> block that carries
// either a duration (<startDate>/<endDate>) or an instant (<instant>) period.
// We do not normalize concept namespaces — we keep them verbatim so a
// downstream consumer can tell us-gaap from a custom taxonomy at a glance.
//
// Per CLAUDE.md deterministic-first: this is the entire extraction path —
// no LLM ever sees raw XBRL. Phase 8 will consume `extractXbrlFacts()`
// output to cross-check numbers against the filing's prose body.

import { XMLParser } from "fast-xml-parser";

export type XbrlPeriod =
    | { kind: "duration"; start: string; end: string }
    | { kind: "instant"; date: string };

export type XbrlFact = {
    concept: string;
    contextRef: string;
    period: XbrlPeriod;
    /** Numeric value when the fact parses as a number; null for textual facts. */
    valueNumeric: number | null;
    valueText: string;
    unit: string | null;
    decimals: number | null;
};

type RawPeriod = {
    startDate?: string | { "#text"?: string };
    endDate?: string | { "#text"?: string };
    instant?: string | { "#text"?: string };
    "xbrli:startDate"?: string | { "#text"?: string };
    "xbrli:endDate"?: string | { "#text"?: string };
    "xbrli:instant"?: string | { "#text"?: string };
};

type RawContext = {
    "@_id"?: string;
    period?: RawPeriod;
    "xbrli:period"?: RawPeriod;
};

type RawElement = {
    "@_contextRef"?: string;
    "@_unitRef"?: string;
    "@_decimals"?: string;
    "#text"?: string | number;
};

// XBRL elements we never want to surface as facts — the XBRLi container
// elements (contexts, units, schemaRef, etc.).
const STRUCTURAL_PREFIXES = new Set([
    "xbrli",
    "link",
    "xlink",
    "xsi",
    "xbrldi",
]);

function isStructural(tag: string): boolean {
    const prefix = tag.includes(":") ? tag.split(":")[0] : "";
    return STRUCTURAL_PREFIXES.has(prefix);
}

function parseDecimals(raw: string | undefined): number | null {
    if (raw == null || raw === "") return null;
    if (raw.toUpperCase() === "INF") return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}

function parseNumeric(raw: string): number | null {
    if (!raw) return null;
    const cleaned = raw.replace(/,/g, "").trim();
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
}

function readMaybeText(
    v: string | { "#text"?: string } | Array<string | { "#text"?: string }> | undefined,
): string | null {
    if (v == null) return null;
    if (Array.isArray(v)) return readMaybeText(v[0]);
    if (typeof v === "string") return v;
    if (typeof v === "object" && typeof v["#text"] === "string") return v["#text"];
    if (typeof v === "object" && typeof v["#text"] === "number")
        return String(v["#text"]);
    return null;
}

function indexContexts(root: Record<string, unknown>): Map<string, XbrlPeriod> {
    const out = new Map<string, XbrlPeriod>();
    // Contexts and their period sub-elements appear both with and without
    // the xbrli: prefix depending on the filer's namespace declarations.
    const contexts = [
        ...toArray(root["xbrli:context"]),
        ...toArray(root["context"]),
    ] as RawContext[];
    for (const c of contexts) {
        const id = c["@_id"];
        const period = c.period ?? c["xbrli:period"];
        if (!id || !period) continue;
        const start =
            readMaybeText(period.startDate) ??
            readMaybeText(period["xbrli:startDate"]);
        const end =
            readMaybeText(period.endDate) ??
            readMaybeText(period["xbrli:endDate"]);
        const instant =
            readMaybeText(period.instant) ??
            readMaybeText(period["xbrli:instant"]);
        if (start && end) {
            out.set(id, { kind: "duration", start, end });
        } else if (instant) {
            out.set(id, { kind: "instant", date: instant });
        }
    }
    return out;
}

function toArray<T>(v: T | T[] | undefined): T[] {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

/**
 * Parse an XBRL instance document and return every numeric/textual fact
 * with its resolved period. The order of returned facts matches the order
 * they appear in the source — useful for stable test fixtures.
 */
export function extractXbrlFacts(xml: string | Buffer): XbrlFact[] {
    const src = typeof xml === "string" ? xml : xml.toString("utf-8");
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        // Keep namespace prefixes so us-gaap:Revenues stays distinct.
        removeNSPrefix: false,
        // We want #text so element bodies are always reachable, even when
        // attributes are present alongside.
        textNodeName: "#text",
        // Don't auto-coerce; we coerce ourselves with explicit rules.
        parseAttributeValue: false,
        parseTagValue: false,
        trimValues: true,
    });

    const doc = parser.parse(src) as Record<string, unknown>;
    // Instance roots vary: `<xbrl>` or `<xbrli:xbrl>`. Take whichever exists.
    const rootKey = Object.keys(doc).find(
        (k) => k === "xbrl" || k === "xbrli:xbrl",
    );
    if (!rootKey) return [];
    const root = doc[rootKey] as Record<string, unknown>;

    const contexts = indexContexts(root);
    const facts: XbrlFact[] = [];

    for (const [tag, value] of Object.entries(root)) {
        if (isStructural(tag)) continue;
        if (tag === "unit" || tag === "xbrli:unit") continue;
        if (tag.startsWith("@_")) continue;
        if (tag === "#text") continue;

        const elements = toArray(value) as RawElement[];
        for (const el of elements) {
            if (el == null || typeof el !== "object") continue;
            const contextRef = el["@_contextRef"];
            if (!contextRef) continue;
            const period = contexts.get(contextRef);
            if (!period) continue;
            const text = el["#text"] == null ? "" : String(el["#text"]);
            const valueNumeric = parseNumeric(text);
            facts.push({
                concept: tag,
                contextRef,
                period,
                valueNumeric,
                valueText: text,
                unit: el["@_unitRef"] ?? null,
                decimals: parseDecimals(el["@_decimals"]),
            });
        }
    }

    return facts;
}
