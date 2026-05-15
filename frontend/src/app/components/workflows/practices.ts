export const PRACTICE_OPTIONS = [
    "M&A Diligence",
    "Private Equity",
    "Private Credit",
    "Leveraged Finance",
    "Project Finance",
    "Investment Banking",
    "Equity Research",
    "Credit Research",
    "Restructuring",
    "Public Markets",
    "Venture & Growth",
    "Real Assets",
    "Corporate Finance",
    "Audit & Accounting",
    "Risk & Compliance",
    "General Transactions",
    "Others",
] as const;

export type Practice = (typeof PRACTICE_OPTIONS)[number];
