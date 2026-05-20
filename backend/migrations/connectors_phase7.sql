-- Phase 7: connector framework + EDGAR.
--
-- Connectors fetch documents from outside systems (SEC EDGAR for this phase;
-- Google Drive + Capital IQ in Phase 11) and land them as regular rows in
-- `public.documents`. The columns below record provenance so that:
--   1. We can dedupe on re-ingest (same accession + same document role
--      shouldn't make a second row).
--   2. Audit / forensics can trace a document back to its source system.
--   3. The per-source routing seam (decisions.md 2026-05-15) can match on
--      `source_connector` later if a policy needs to.
--
-- `source_ref` is intentionally jsonb so each connector picks its own shape.
-- For EDGAR today: { accession_number, cik, ticker, form_type,
--                    period_of_report, filing_date, primary_doc_url,
--                    document_role: 'primary' | 'exhibit' | 'xbrl',
--                    exhibit_type? }

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS source_connector text,
  ADD COLUMN IF NOT EXISTS source_ref jsonb;

-- Dedupe re-ingests: same connector + accession + role = same document.
-- Partial index — only enforced for connector-imported rows; manual uploads
-- leave both columns null and don't participate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_dedupe
  ON public.documents (
    source_connector,
    (source_ref->>'accession_number'),
    (source_ref->>'document_role')
  )
  WHERE source_connector IS NOT NULL
    AND source_ref ? 'accession_number'
    AND source_ref ? 'document_role';

CREATE INDEX IF NOT EXISTS idx_documents_source_connector
  ON public.documents (source_connector)
  WHERE source_connector IS NOT NULL;

-- ---------------------------------------------------------------------------
-- edgar_facts: structured ground truth from XBRL instance documents.
--
-- One row per (document, concept, context). The cross-doc consistency
-- check in Phase 8 will compare these facts against numbers extracted
-- from the prose body of the filing — a mismatch surfaces a citation
-- issue without any LLM in the loop.
--
-- Per CLAUDE.md deterministic-first principle: this table is populated
-- by a pure XBRL parser at ingest time. No LLM ever writes here.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.edgar_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  accession_number text NOT NULL,
  cik text NOT NULL,
  -- Element name as it appears in the instance doc, e.g. "us-gaap:Revenues".
  concept text NOT NULL,
  -- Numeric value when the fact is a number; null for textual facts.
  value_numeric numeric,
  -- Verbatim string value (also populated for numeric facts so we can
  -- cite the raw representation, scale and all).
  value_text text,
  -- Currency, shares, pure, etc. ("iso4217:USD", "xbrli:shares", null).
  unit text,
  -- Either (period_start, period_end) for duration contexts or
  -- `instant` for point-in-time. Exactly one of {(start,end), instant}
  -- is populated.
  period_start date,
  period_end date,
  instant date,
  -- Original contextRef id from the instance, kept for traceability.
  context_ref text,
  -- XBRL `decimals` attribute — tells us the precision the filer asserted.
  decimals integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_edgar_facts_document
  ON public.edgar_facts (document_id);

CREATE INDEX IF NOT EXISTS idx_edgar_facts_concept_cik
  ON public.edgar_facts (cik, concept);

CREATE INDEX IF NOT EXISTS idx_edgar_facts_accession
  ON public.edgar_facts (accession_number);
