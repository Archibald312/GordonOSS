# GordonOSS — Working Notes for Claude

Open-source, self-hostable, BYO-key AI platform for finance professionals. Fork of [willchen96/mike](https://github.com/willchen96/mike) (legal AI) repositioned for finance (M&A diligence, PE, credit, equity research, IB). AGPL v3. Competes against Hebbia and Rogo on price, sovereignty (air-gap / BYO-key), and citation auditability.

## Architecture principle: deterministic-first

**Default to deterministic tooling for extraction, normalization, math, and pattern-matching. Reserve LLM calls for open-ended reasoning, ambiguity resolution, and narrative generation.**

The citation IS the product. A regex match has a byte offset and is provably correct. An LLM "found" a number that needs human verification. In finance, that difference is the whole trust story.

For any new feature, ask first: where is the LLM actually needed? Then minimize that surface.

**Use deterministic code for:**
- Numeric, date/period, currency, percentage extraction → regex with byte-offset citations
- Named-entity recognition → spaCy (ONNX) or `compromise.js`, run locally
- Unit/scale normalization (`$4.2M` → `4200000`) → pure functions
- Entity matching/clustering ("Acme" = "Acme Corp.") → fuzzy string match (Jaro-Winkler) with explainable thresholds
- Defined-terms extraction from legal docs → regex/PEG grammar (`"X" shall mean …`, `"X" means …`, etc.)
- Value comparison, math, formula evaluation → real parsers, not prompts
- Aho-Corasick or trie scans for term lookup in document bodies
- File-format parsing (xlsx, pdf, docx) → established libs, never LLM

**Use LLM for:**
- Context-sensitive extraction that regex flagged as ambiguous ("Revenue *excluding the divested European segment* was $120M")
- Definition reconciliation (Adjusted EBITDA vs Reported EBITDA across docs)
- Narrative report generation on top of structured ground truth
- Open-ended Q&A and freeform chat

**Code organization rule:** deterministic extractors live under `backend/src/lib/extractors/` (born in Phase 9 when first consumed). LLM tools in `backend/src/lib/tools/` *consume* extractor output — they don't re-do the extraction work. Extractors are side-effect-free pure code with heavy unit coverage.

**Anti-pattern:** "If all you have is a hammer, everything looks like a nail." LLM-everything is fast to prototype but loses on cost, latency, auditability, and air-gap suitability. Hebbia and Rogo are LLM-native for extraction; that's a vulnerability we exploit, not copy.

## Stack snapshot

- **Backend:** Node/Express + TypeScript, Supabase (auth + Postgres), Cloudflare R2 (storage). Entry: `backend/src/index.ts`.
- **Frontend:** Next.js 16 + React 19 + Tailwind + Radix. Pages in `frontend/src/app/`.
- **LLM providers:** Claude, Gemini, OpenAI, all BYO-key. Adapters in `backend/src/lib/llm/`.
- **Tool registry (post-refactor):** `backend/src/lib/tools/` — one file per tool, registered via `backend/src/lib/tools/registry.ts`, dispatched via `backend/src/lib/tools/dispatcher.ts`. Shared helpers in `backend/src/lib/tools/shared/`.
- **Access control:** `backend/src/lib/access.ts` (app-layer checks today; Postgres RLS lands in Phase 13).
- **Tests:** Vitest for `backend/tests/unit/`, Playwright for `e2e/`, CI in `.github/workflows/`.

## Build plan (Phase 4 → 14)

Original plan: `~/Downloads/build-plan.md` (Phases 0–3 complete). Revised order (local inference deferred post-launch; see 2026-05-15 decision in `decisions.md`):

| Phase | Focus |
|---|---|
| 4 | Domain swap (legal → finance copy, prompts, workflows) |
| 5 | Excel I/O (xlsx ingestion + emission with cell-level citation comments) |
| 6 | Audit logging |
| 7 | Connector framework + EDGAR (Tier 1 reference) |
| 8 | **Cross-doc consistency check + birth of `backend/src/lib/extractors/`** (numbers, entities, periods, factTuples) |
| 9 | Defined-terms hover (extractor + Aho-Corasick + UI; zero LLM in hot path) |
| 10 | Finance workflow library (CIM, comps, IC memo, covenant, earnings, KPI, market map) |
| 11 | Google Drive + Capital IQ connectors |
| 12 | Postgres Row Level Security |
| 13 | Polish + launch |
| 14 | (post-launch) Local inference (Ollama/vLLM) adapter + activation of routing policy |

**Pre-Phase-7 seam (landed early, see `decisions.md` 2026-05-15 entry):** per-source LLM routing — `documents.model_preference` + `projects.model_preference` columns, `backend/src/lib/llm/routing.ts` resolver, and `streamChatWithTools` records the resolution into the existing `audit_log.routing_policy_applied` column. Today the resolver returns the requested model unchanged. Phase 7 connectors populate `model_preference` at ingest; Phase 14 wires the local-inference adapter into the same resolver without further dispatch-site changes. This is why local inference (originally Phase 7) is cheap to add later: the load-bearing decision surface already exists.

## Future capabilities (not yet scheduled into a phase)

These are confirmed-desired features that don't warrant a dedicated phase. Fold them into the closest in-progress phase when the surrounding work makes the marginal cost low, or batch into Phase 14 polish.

- **Editable XlsxView formula bar / cells.** Today the formula bar in `frontend/src/app/components/shared/XlsxView.tsx` is read-only. Making cells editable requires: write-through to ExcelJS → repackage workbook → POST a new document version (reusing the existing version-upload route) → invalidate the bytes cache → reconcile against any pending tracked changes on sibling docx documents in the same chat. Roughly half a day. Defer until a workflow needs it (likely surfaces during Phase 11 CIM/comps workflows).
- **Server-side `generate_xlsx` LLM tool.** Phase 5 ships read + cite + comment-on-export. The deferred half is letting the LLM author a workbook from scratch (e.g. "build me a comps table") with cell-level citations baked into ExcelJS comments. Pair with Phase 11 finance workflows.
- **Data-privacy tier guard for LLM dispatch.** The original `lib/llm/freeTierGuard.ts` was removed because it kept blocking real dev work against free-tier Gemini; the right design is to gate on *data sensitivity* rather than model tier (a per-project flag like `data_class = "public" | "internal" | "customer"`, with the model-tier list as one input among many). Reintroduce when the connector framework (Phase 7) gives us a clear pull of "what classifies as customer data." The routing seam at `backend/src/lib/llm/routing.ts` is the natural home for it — add a `block` outcome to the resolver alongside the `model` it returns.

## Things to remember across sessions

- Run one phase at a time. Verify acceptance criteria before starting the next.
- Tracked-change DOCX edits (`backend/src/lib/docxTrackedChanges.ts`) are a unique strength vs Hebbia/Rogo — preserve and highlight.
- Page-level citations with verbatim quotes already exist in tabular reviews — extend rather than rebuild.
- When deviating from the plan, record the decision in `decisions.md` at the repo root with a one-paragraph reason.
- Prefer the more conservative option on security/routing/encryption decisions.
