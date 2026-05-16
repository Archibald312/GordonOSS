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

## 2026-05-15 — Phase 5: Excel I/O (xlsx/xls/xlsm/csv ingestion + emission)

**Scope changes vs. the original plan:**

1. **Birthed `backend/src/lib/extractors/` in Phase 5 instead of Phase 9.** The original plan slotted the extractors directory into Phase 9 (cross-doc consistency check). Phase 5 needs deterministic cell-level extraction immediately — the citation IS the product, and a workbook citation has no integrity without a verbatim cell value at `Sheet!Address`. So `extractors/xlsx.ts` and `extractors/csv.ts` ship now; later phases (defined-terms, numbers, entities, factTuples) populate the same directory. Pure code, unit-tested, no LLM in the hot path.

2. **`.xls` (legacy BIFF) is normalized to `.xlsx` at upload time via LibreOffice** rather than carried as a second format through the pipeline. One parser (ExcelJS) covers `.xlsx`, `.xlsm`, and `.xls`-converted-to-`.xlsx`. The user's original filename is preserved; only the bytes and `file_type` get rewritten. `.xlsm` macros are never executed — we only parse the workbook XML.

3. **CSV bundled into this phase.** The original plan focused on xlsx; CSV slid in because (a) finance teams ingest CSV deliverables all the time (broker exports, EDGAR XBRL-to-CSV, fund accounting trial balances), and (b) the extractor surface is the same shape as xlsx, so the marginal cost was a tiny RFC 4180 parser. Both extractors emit the same `XlsxExtract` shape so the LLM-facing flattener works on either.

4. **Citation `page` field reused for cell addresses; no new `cell` field.** The end-to-end citation type is already `page: number | string`. Spreadsheet citations encode the cell as `"Income Statement!B12"`. `normalizeCitation` was loosened to preserve any `page` string containing `!` or matching a bare cell-address regex instead of forcing it to `1`. The frontend `formatCitationPage` and `expandCitationToEntries` were extended to recognize and route spreadsheet refs into the new `cellRef` field on `CitationQuote`, which the new `XlsxView` uses to locate and highlight the target cell.

5. **Emission scope limited to client-side tabular-review export comments.** The user explicitly scoped Phase 5 to "tabular review export with cell comments" and deferred a general-purpose `generate_xlsx` LLM tool. `frontend/src/app/components/tabular/exportToExcel.ts` attaches an ExcelJS `cell.note` to every exported cell that carries citations — comments contain `[N] filename — Page N — "quote"` lines. Source-side spreadsheet citations in tabular reviews are out of scope until a finance workflow specifically needs them; `preprocessCitations` continues to expect numeric pages (PDF/DOCX-backed tabular reviews are the dominant case).

6. **Minimal HTML grid viewer (`XlsxView`)** renders sheets as `<table>` elements with per-cell `data-sheet`/`data-cell` attributes. Sheet tabs at the top; a fixed left-column row index; a yellow highlight applied for ~2.5s on citation clicks. Reuses the existing `useFetchDocxBytes` hook because the `/single-documents/:id/docx` route streams whatever bytes are at the active version's `storage_path` — the response `Content-Type` header is wrong for xlsx but irrelevant when consuming `arrayBuffer()`. Mounted from `DocPanel` and `DocViewModal`.

7. **Document-row upload path:** `ALLOWED_TYPES` extends to include the four new suffixes. Spreadsheets skip the DOCX→PDF conversion (no PDF rendition is created). `extractStructureTree` returns the sheet list as level-1 nodes so the existing outline UI displays sheet names. `pageCount` is left `null` for spreadsheets — pages don't apply.

**Verification:** backend `tsc --noEmit` clean; backend Vitest 69/69 passing (10 new extractor tests).

## 2026-05-15 — Deferring local inference; building per-source routing seam early

**Change vs. the original plan:**

1. **Phase 7 (local inference: Ollama/vLLM) deferred to post-launch.** Reason: there are no external users on the platform yet and the maintainer can't run local models on the dev machine, so building a code path that can't be exercised is speculative. The LLM adapter layer already abstracts Claude/Gemini/OpenAI behind a single interface (`backend/src/lib/llm/{claude,gemini,openai}.ts` + `index.ts`), so adding a fourth adapter later is a day's work — not architecturally load-bearing.

2. **Per-source LLM routing seam built now, before Phase 8 connectors.** Reason: the *adapter* is cheap to add later, but the *routing policy* surface (deciding which model handles content from which source) is the part that gets baked into call sites and connector code. If Phase 8 ships connectors assuming "one model per chat/project," retrofitting per-source routing later means touching every connector, every dispatch path, and probably the audit row shape — exactly the kind of cross-cutting churn that becomes real tech debt. So we land the seam (column + resolver + audit field) ahead of the connector framework. Today the resolver returns the user's requested model unchanged; tomorrow it consults the policy.

**Scope of the seam (this work, branch `phase-pre8-model-routing-seam`):**

- `documents.model_preference text` (nullable). Connector-imported docs in Phase 8 will populate this at ingest from the connector's declared preference. Manually-uploaded docs leave it null.
- `projects.model_preference text` (nullable). Project-level override.
- `backend/src/lib/llm/routing.ts` exports `resolveModelRouting(ctx, requestedModel)` returning `{ model, policy }`. Precedence: any document-level preference (first non-null wins, conflicts recorded in `policy.conflicts`) → project-level → requested. The function is pure DB-read + decision; no LLM call.
- `streamChatWithTools` accepts an optional `routing?` context. When present, it resolves the model before dispatch and records the resolution into the existing `audit_log.routing_policy_applied jsonb` column (already shipped in Phase 6). When absent, behavior is identical to today (no resolution, no policy row).
- No UI exposed for `model_preference` yet — there are no users to expose it to. Setting it is a SQL/admin-API job until Phase 14 polish or whenever a workflow needs it.

**What we explicitly are NOT building now:** the local-inference adapter, the policy admin UI, a separate `routing_policies` table, or per-document-type routing (PDF vs xlsx vs ingested-from-X). Those are all post-Phase-14 if ever.

**Renumbering:** Phase 7 = Connector framework + EDGAR (was 8). Each subsequent phase shifts up by one. Local inference + adapter lands as Phase 15 post-launch. CLAUDE.md updated to match.

**Verification:** backend `tsc --noEmit` clean; backend Vitest passing (resolver tests added).
