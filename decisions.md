# Decisions Log

Per `CLAUDE.md`: "When deviating from the plan, record the decision in `decisions.md` at the repo root with a one-paragraph reason."

## 2026-05-15 — Phase 4: Domain swap (legal → finance)

**Scope changes vs. the original plan:**

1. **Kept all 12 built-in legal workflows untouched.** The original Phase 4 read like "convert workflows from legal to finance," but Phase 11 already covers the finance workflow library (CIM, comps, IC memo, covenant, earnings, KPI, market map). Reframing legal workflows now would duplicate work and risk losing useful templates that finance buyers may still want (Credit Agreement Review and LPA Review are already finance-native; SPA and shareholder reviews remain relevant to M&A diligence). Defer any workflow surgery to Phase 11 when the full finance template set is being designed. The legacy practice values on these workflows ("Corporate", "Litigation", "Real Estate", etc.) flow through as plain strings — the dropdown widens to finance verticals via the "Others" + custom-text fallback path, so nothing breaks.

2. **Did the `Mike → Gordon` rename inside Phase 4.** The build plan didn't call this out as a distinct task, but the brand swap is the visible half of "domain swap." Renaming was mechanical: 9 type identifiers (`MikeMessage`, `MikeWorkflow`, etc.) → `Gordon*`; 2 file renames (`mike-icon.tsx`, `mikeApi.ts`); MIME types (`application/mike-doc` → `application/gordon-doc`); localStorage key (`mike.selectedModel` → `gordon.selectedModel`); R2 bucket default in `.env.example` (`mike` → `gordon`). Operational impact: anyone deploying off the example config gets a new bucket default; the localStorage rename forces users to re-select their model on next login. Both acceptable. The `FORK.md` upstream URL references to `willchen96/mike` are intentionally preserved — that's the actual upstream repo for fork governance.

3. **Practice area list — full replacement, not augmentation.** The original list contained 19 legal practice areas (Litigation, Real Estate, Tax, IP, Competition, Employment, etc.). Replaced wholesale with 17 finance verticals (M&A Diligence, PE, Private Credit, Lev Fin, Project Finance, IB, Equity/Credit Research, Restructuring, etc.). Kept "General Transactions" and "Others" as escape hatches. Old workflows that reference removed practices still display correctly because `practice` is typed as `string | null` end-to-end; the UI's "Others + custom" pathway covers unknown values.

4. **Column presets — additive, not replacement.** Existing legal-flavored presets (Warranties, Force Majeure, Indemnity, Confidentiality, etc.) match generic contract terms that appear in finance documents too (credit agreements, indentures, SPAs). Removing them would harm users running tabular review over contracts. Added finance-specific presets (Revenue, EBITDA, Net Income, FCF, Leverage Ratio, Interest Coverage, Reporting Period, Maturity, Coupon/Rate, Currency, Capex, Margin) so finance users get auto-prompts for their workflows. The regex-based matching gives the right preset whichever the user types first.

5. **Left `LEGAL_NUMBERING_REF` identifier untouched in `shared/generateDocx.ts`.** That refers to Word's built-in `legal` numbering style (a docx XML attribute that forces all numbering levels to arabic), not "legal documents." Renaming would be misleading.

6. **System-prompt rewrites are minimal.** Replaced "AI legal assistant / legal analyst" with "AI finance assistant / finance analyst" and adjusted the framing line in `chatTools.ts` SYSTEM_PROMPT to invoke finance disciplines (M&A, PE, private credit, lev fin, IB, research) and emphasize citation auditability — leaving the citation, docx, edit, and numbering instructions intact because those are mechanism, not domain. Per the deterministic-first principle, the LLM system prompt is the right place for the framing because it's the open-ended-reasoning surface; deterministic citation and numbering machinery stays separate.

**Verification:** backend `tsc --noEmit` clean; frontend `tsc --noEmit` clean; backend Vitest 57/57 passing.
