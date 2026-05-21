-- Phase 8: cross-doc consistency check.
--
-- Deterministic extractors (numbers, periods, entities, fact-tuples) scan
-- document prose and emit (entity, concept, period, value, unit) tuples
-- with byte-offset citations. The consistency engine compares those tuples
-- to other ground truth — XBRL facts from the same accession (intra-doc)
-- or fact-tuples from sibling documents in the same project (cross-doc) —
-- and records mismatches here.
--
-- Per CLAUDE.md deterministic-first: no LLM ever writes to this table.
-- The engine is pure code with byte-offset citations on both sides of
-- every finding, so any mismatch is provably traceable to its source.
--
-- One row per finding. `severity` is the engine's classification:
--   'mismatch'   — same (entity, concept, period) tuple, different value
--   'unit_drift' — same fact, different unit (USD vs USD millions etc.)
--   'orphan'     — prose value with no matching ground truth (informational)
--
-- `left_*` and `right_*` carry the two sides being compared. For intra-doc
-- XBRL comparisons, `right_kind = 'xbrl'` and `right_document_id` points at
-- the XBRL instance document. For cross-doc, both sides are 'prose'.

CREATE TABLE IF NOT EXISTS public.consistency_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Groups findings from a single check invocation. Lets the UI render
  -- "run from 2026-05-20 10:14" rather than mixing runs together.
  run_id uuid NOT NULL,
  user_id text NOT NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK (severity IN ('mismatch', 'unit_drift', 'orphan')),
  -- Canonical fact identity — used to group findings about the same fact
  -- across runs / cross-doc surfaces.
  entity text,
  concept text NOT NULL,
  period_key text NOT NULL,
  -- Left side: always the prose extraction being checked.
  left_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  left_value_numeric numeric,
  left_value_text text,
  left_unit text,
  left_byte_offset integer,
  left_byte_length integer,
  left_quote text,
  -- Right side: either another prose extraction (cross-doc) or an XBRL fact.
  right_kind text NOT NULL CHECK (right_kind IN ('xbrl', 'prose')),
  right_document_id uuid REFERENCES public.documents(id) ON DELETE CASCADE,
  -- For XBRL right-side, points at edgar_facts.id; null for prose right-side.
  right_fact_id uuid REFERENCES public.edgar_facts(id) ON DELETE CASCADE,
  right_value_numeric numeric,
  right_value_text text,
  right_unit text,
  right_byte_offset integer,
  right_byte_length integer,
  right_quote text,
  -- Optional structured diff (e.g. {"delta": 100000, "delta_pct": 0.03}).
  details jsonb,
  -- Lifecycle: every new finding starts 'open'; users (Phase 11+) may mark
  -- 'resolved' (legitimate diff, e.g. restated) or 'dismissed' (noise).
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_consistency_findings_run
  ON public.consistency_findings(run_id);

CREATE INDEX IF NOT EXISTS idx_consistency_findings_project_status
  ON public.consistency_findings(project_id, status)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consistency_findings_left_doc
  ON public.consistency_findings(left_document_id);

CREATE INDEX IF NOT EXISTS idx_consistency_findings_right_doc
  ON public.consistency_findings(right_document_id)
  WHERE right_document_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Extend audit_log event_type so consistency runs are auditable.
-- ---------------------------------------------------------------------------

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_event_type_check;

ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_event_type_check
  CHECK (event_type IN (
    'llm_call',
    'tool_call',
    'connector_fetch',
    'document_upload',
    'document_download',
    'consistency_check'
  ));
