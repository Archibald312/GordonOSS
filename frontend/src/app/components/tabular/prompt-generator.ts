const PROMPT_PRESETS: Array<{
    matches: RegExp;
    prompt: (title: string) => string;
}> = [
    {
        matches: /\bpart(y|ies)\b/i,
        prompt: () =>
            'Identify all parties referenced in the document. List their full names and describe each party\'s role or capacity in the agreement. If a party is not clearly identified, state "Not addressed".',
    },
    {
        matches: /\bchange of control\b/i,
        prompt: () =>
            'Identify any change of control provisions in the document. Summarize the trigger, the consequences, any consent requirements, and any related termination, acceleration, or notice obligations. If not addressed, state "Not addressed".',
    },
    {
        matches: /\bterminat(e|ion|ing)\b/i,
        prompt: () =>
            'Extract the termination provisions in the document. Summarize who may terminate, the termination triggers, any notice requirements, cure periods, and the consequences of termination. If not addressed, state "Not addressed".',
    },
    {
        matches: /\bgoverning law\b|\bjurisdiction\b/i,
        prompt: () =>
            'Identify the governing law and jurisdiction provisions in the document. State the governing law, the forum for disputes, and any submission to jurisdiction or venue requirements. If not addressed, state "Not addressed".',
    },
    {
        matches: /\bconfidential(ity)?\b|\bnon-?disclosure\b/i,
        prompt: () =>
            'Extract the confidentiality provisions in the document. Summarize the scope of confidential information, permitted disclosures, use restrictions, duration, and any carve-outs or exceptions. If not addressed, state "Not addressed".',
    },
    {
        matches: /\bassign(ment|ability)?\b/i,
        prompt: () =>
            'Identify any assignment provisions in the document. Summarize whether assignment is permitted, restricted, or requires consent, and note any exceptions or deemed assignments. If not addressed, state "Not addressed".',
    },
    {
        matches: /\bpayment\b|\bfees?\b/i,
        prompt: () =>
            'Extract the payment and fee terms in the document. Summarize payment obligations, amounts, timing, currencies, fee types, and any consequences for late or missed payment. If not addressed, state "Not addressed".',
    },
    {
        matches: /\brevenue\b|\bnet sales\b|\btop[\s-]?line\b/i,
        prompt: () =>
            'Extract reported revenue (or net sales) in the document. State the amount, currency, reporting period, whether GAAP/non-GAAP/adjusted, and segment breakdown if disclosed. If not addressed, state "Not addressed".',
    },
    {
        matches: /\bebitda\b/i,
        prompt: () =>
            'Extract EBITDA in the document. State the amount, currency, period, and whether Reported, Adjusted, Pro Forma, Run-Rate, or Bank EBITDA. List disclosed add-backs. If not addressed, state "Not addressed".',
    },
    {
        matches: /\bleverage\b|\bdebt\s*\/\s*ebitda\b/i,
        prompt: () =>
            'Extract the leverage ratio in the document. State the value, numerator (total vs. net debt; senior vs. total), denominator (LTM, NTM, Adjusted EBITDA), and the test/measurement date. If not addressed, state "Not addressed".',
    },
    {
        matches: /\bmaturity\b/i,
        prompt: () =>
            'Identify the maturity provisions in the document. State the final maturity date (or per-tranche maturities) and any extension or springing maturity mechanics. If not addressed, state "Not addressed".',
    },
    {
        matches: /\binterest rate\b|\bcoupon\b|\bspread\b|\bmargin\b/i,
        prompt: () =>
            'Extract the interest rate or coupon in the document. State the reference rate (SOFR, EURIBOR, fixed, etc.), spread/margin in bps, any margin ratchet or step-ups, the day-count convention, and the interest period. If not addressed, state "Not addressed".',
    },
];

export function getPresetTabularPrompt(title: string): string | null {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return null;

    const preset = PROMPT_PRESETS.find(({ matches }) => matches.test(trimmedTitle));
    return preset ? preset.prompt(trimmedTitle) : null;
}

export function buildFallbackTabularPrompt(title: string): string {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return "";

    return (
        `Review each document and extract the information relevant to "${trimmedTitle}". ` +
        `Provide a concise, document-specific summary for this column. ` +
        `Include the key facts, dates, thresholds, parties, and conditions where applicable. ` +
        `If the document does not contain relevant information, return "Not addressed".`
    );
}
