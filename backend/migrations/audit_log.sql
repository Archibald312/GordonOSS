-- Phase 6: append-only audit log.
--
-- Every LLM call and every tool invocation lands here. Required before paid
-- data connectors so we can prove who saw what data and which model handled
-- it. Updates and deletes are blocked at the DB layer — entries are immutable
-- once written.
--
-- user_email is denormalized for forensic retention: if a user row is later
-- deleted, the FK on user_id gets NULLed (or row removed if cascade applies)
-- but the email still appears so investigators can identify the actor.

CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email text,
  event_type text NOT NULL CHECK (event_type IN (
    'llm_call',
    'tool_call',
    'connector_fetch',
    'document_upload',
    'document_download'
  )),
  model text,
  provider text,
  tool_name text,
  connector_id text,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  document_ids uuid[],
  source_license_scopes text[],
  routing_policy_applied jsonb,
  input_hash text,
  output_hash text,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  status text NOT NULL CHECK (status IN ('success', 'error', 'blocked')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_created
  ON public.audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_project_created
  ON public.audit_log(project_id, created_at DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_event_type
  ON public.audit_log(event_type);

CREATE OR REPLACE FUNCTION public.prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log entries are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON public.audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON public.audit_log
  FOR EACH ROW EXECUTE PROCEDURE public.prevent_audit_log_modification();

DROP TRIGGER IF EXISTS audit_log_no_delete ON public.audit_log;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON public.audit_log
  FOR EACH ROW EXECUTE PROCEDURE public.prevent_audit_log_modification();

REVOKE ALL ON public.audit_log FROM anon, authenticated;
