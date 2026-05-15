import type { ColumnFormat } from "../shared/types";

export interface ColumnPreset {
    name: string;
    matches: RegExp;
    prompt: string;
    format: ColumnFormat;
    tags?: string[];
}

export const PROMPT_PRESETS: ColumnPreset[] = [
    {
        name: "Parties",
        matches: /\bpart(y|ies)\b/i,
        format: "bulleted_list",
        prompt: 'List all parties to this agreement. For each party, state their full legal name, entity type, and defined role, e.g.:\n• ABC Corp, a Delaware corporation ("Company")\n• John Smith ("Shareholder")\nOne party per bullet. No additional commentary.',
    },
    {
        name: "Governing Law",
        matches: /\bgoverning law\b|\bjurisdiction\b/i,
        format: "text",
        prompt: 'State only the governing law of this agreement using the short-form jurisdiction name, e.g. "New York Law", "English Law", "Indian Law", "PRC Law". No other text.',
    },
    {
        name: "Effective Date",
        matches: /\beffective date\b/i,
        format: "date",
        prompt: 'State only the effective date of this agreement in DD Mon YYYY format, e.g. "2 Jan 2026". If not explicitly stated, write "Not specified".',
    },
    {
        name: "Term",
        matches: /\bterm\b|\bduration\b/i,
        format: "text",
        prompt: 'State only the duration or term of this agreement in a concise form, e.g. "3 years", "24 months", "perpetual". No other text.',
    },
    {
        name: "Termination",
        matches: /\bterminat(e|ion|ing)\b/i,
        format: "text",
        prompt: "Extract the termination provisions. State who may terminate, the trigger events, required notice period, any cure period, and the key consequences of termination. Be concise.",
    },
    {
        name: "Change of Control",
        matches: /\bchange of control\b/i,
        format: "text",
        prompt: "Identify any change of control provisions. Summarize the trigger events, consequences, consent requirements, and any related termination or acceleration rights. Be concise.",
    },
    {
        name: "Confidentiality",
        matches: /\bconfidential(ity)?\b|\bnon-?disclosure\b/i,
        format: "text",
        prompt: "Summarize the confidentiality obligations: scope of confidential information, permitted disclosures, use restrictions, duration, and key carve-outs or exceptions.",
    },
    {
        name: "Assignment",
        matches: /\bassign(ment|ability)?\b/i,
        format: "yes_no",
        prompt: "Is assignment of this agreement permitted without the other party's consent?",
    },
    {
        name: "Payment & Fees",
        matches: /\bpayment\b|\bfees?\b/i,
        format: "text",
        prompt: 'State the key payment obligations concisely: amount, timing, and currency, e.g. "USD 10,000 payable within 30 days of invoice". Note any late payment consequences.',
    },
    {
        name: "Amendment",
        matches: /\bamendment\b|\bvariation\b/i,
        format: "text",
        prompt: "Summarize the amendment provisions: how amendments may be made, who must consent, and any formality requirements such as writing or signature.",
    },
    {
        name: "Indemnity",
        matches: /\bindemni(ty|ties|fication)\b/i,
        format: "text",
        prompt: "Summarize the indemnity provisions: who indemnifies whom, the scope of indemnified losses, any liability caps or exclusions, and key claims procedures.",
    },
    {
        name: "Warranties",
        matches: /\bwarrant(y|ies|ing)\b|\brepresentations?\b/i,
        format: "text",
        prompt: "Identify and describe key representations and warranties provided by any party, including the scope of such assurances and any specific time periods or conditions applicable to them. In particular highlight any non-standard warranties.",
    },
    {
        name: "Force Majeure",
        matches: /\bforce majeure\b/i,
        format: "yes_no",
        prompt: "Does this agreement contain a force majeure clause?",
    },

    // ─── Finance-specific presets ────────────────────────────────────────────
    {
        name: "Revenue",
        matches: /\brevenue\b|\bnet sales\b|\btop[\s-]?line\b/i,
        format: "monetary_amount",
        prompt: "Extract reported revenue (or net sales). State the amount, currency, reporting period (e.g. FY2025, Q3 2025), and whether the figure is GAAP, non-GAAP, or adjusted. Quote the exact figure as it appears.",
    },
    {
        name: "EBITDA",
        matches: /\bebitda\b/i,
        format: "monetary_amount",
        prompt: 'Extract EBITDA. State the amount, currency, period, and whether it is Reported, Adjusted, Pro Forma, Run-Rate, or Bank EBITDA. List any add-backs disclosed. If multiple EBITDA figures are presented, return each separately and identify the source.',
    },
    {
        name: "Net Income",
        matches: /\bnet income\b|\bnet earnings\b|\bnet profit\b|\bnet loss\b/i,
        format: "monetary_amount",
        prompt: "Extract net income (or net loss). State the amount, currency, reporting period, and whether attributable to the parent or including non-controlling interests.",
    },
    {
        name: "Free Cash Flow",
        matches: /\bfree cash flow\b|\bfcf\b/i,
        format: "monetary_amount",
        prompt: 'Extract free cash flow. State the amount, currency, period, and the definition used (e.g. CFO minus capex; unlevered FCF; FCF to equity). Note any non-standard adjustments.',
    },
    {
        name: "Leverage Ratio",
        matches: /\bleverage ratio\b|\bnet debt\s*\/\s*ebitda\b|\bdebt\s*\/\s*ebitda\b/i,
        format: "text",
        prompt: 'Extract the leverage ratio. State the ratio value (e.g. 3.5x), the numerator definition (total debt vs. net debt; senior vs. total), the denominator definition (LTM, NTM, Adjusted EBITDA), and the test date or covenant test point.',
    },
    {
        name: "Interest Coverage",
        matches: /\binterest coverage\b|\binterest cover\b/i,
        format: "text",
        prompt: 'Extract the interest coverage ratio. State the ratio value, the numerator (e.g. EBITDA, EBIT, Adjusted EBITDA), the denominator (cash interest, total interest), and the test period.',
    },
    {
        name: "Reporting Period",
        matches: /\b(reporting )?period\b|\bfiscal year\b|\bfy\b|\bquarter\b/i,
        format: "text",
        prompt: 'State the reporting period covered by this document (e.g. "FY2025", "Q2 2025", "twelve months ended 30 Jun 2025"). Note the fiscal year-end if it differs from calendar year.',
    },
    {
        name: "Maturity",
        matches: /\bmaturity\b|\bmaturity date\b/i,
        format: "date",
        prompt: 'State the final maturity date of the facility, instrument, or obligation in DD Mon YYYY format. If multiple tranches have different maturities, list each.',
    },
    {
        name: "Coupon / Rate",
        matches: /\bcoupon\b|\binterest rate\b|\bspread\b|\bmargin\b/i,
        format: "text",
        prompt: 'Extract the applicable interest rate. State the reference rate (SOFR, EURIBOR, fixed, etc.), the spread/margin (in bps), any margin ratchet or step-ups, the day-count convention, and the interest period.',
    },
    {
        name: "Currency",
        matches: /\bcurrency\b|\bdenomination\b/i,
        format: "text",
        prompt: 'State the currency in which the amount, facility, or instrument is denominated using ISO 4217 codes (e.g. USD, EUR, GBP). If multi-currency, list each currency and its applicable use.',
    },
    {
        name: "Capex",
        matches: /\bcapex\b|\bcapital expenditures?\b/i,
        format: "monetary_amount",
        prompt: 'Extract capital expenditures. State the amount, currency, period, and whether maintenance capex and growth capex are reported separately. Note any guidance for future periods.',
    },
    {
        name: "Margin",
        matches: /\b(gross|operating|ebitda|net) margin\b/i,
        format: "percentage",
        prompt: 'Extract the margin requested by the column title. State the percentage, the period, and the numerator/denominator basis. If the document reports both reported and adjusted margins, return each separately.',
    },
];

export function getPresetConfig(
    title: string,
): Pick<ColumnPreset, "prompt" | "format" | "tags"> | null {
    const trimmed = title.trim();
    if (!trimmed) return null;
    const preset = PROMPT_PRESETS.find(({ matches }) => matches.test(trimmed));
    if (!preset) return null;
    return { prompt: preset.prompt, format: preset.format, tags: preset.tags };
}

export function getPresetPrompt(title: string): string | null {
    return getPresetConfig(title)?.prompt ?? null;
}
