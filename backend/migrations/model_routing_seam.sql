-- Pre-Phase-7: per-source LLM routing seam.
--
-- See `decisions.md` (2026-05-15 entry). Local inference is deferred to
-- post-launch, but the routing surface is the part that gets baked into
-- connector code, so we land the seam ahead of Phase 7 connectors.
--
-- Today these columns are read by `backend/src/lib/llm/routing.ts` and
-- always resolve to "use the model the caller requested." Phase 7
-- connectors populate `documents.model_preference` at ingest time from the
-- connector's declared preference; users / admins set `projects.model_preference`
-- as a project-wide override. No UI surfaces these yet — by design.
--
-- Precedence at resolve time:
--   1. any document in the request has a non-null model_preference
--   2. project has a non-null model_preference
--   3. caller's requested model
--
-- Conflicts (two documents with different preferences) are recorded into
-- `audit_log.routing_policy_applied` but do not block — first non-null wins
-- until a real policy engine lands in Phase 14.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS model_preference text;

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS model_preference text;
