-- PS-234 — append-only audit log.
--
-- One immutable row per business-critical mutation (credentials, labels, orders
-- incl. ?force=1 overrides, billing, settings). Records actor + resource + action
-- + masked details + IP — the forensic trail AUDIT_LOGGING_MATRIX.md requires.
--
-- APPEND-ONLY is enforced at the DB level: a BEFORE UPDATE OR DELETE trigger
-- raises for EVERY role, including the backend postgres owner — so history can
-- never be rewritten (stronger than role grants alone). `details` is jsonb and
-- MUST be written via redactAuditDetails() so no raw secret/token lands here.
--
-- Additive only. Idempotent (IF NOT EXISTS) and matched by the runtime ensure in
-- src/services/audit-log.ts (ensureAuditLogSchema).

CREATE TABLE IF NOT EXISTS audit_log (
  id serial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  actor_id text,
  actor_email text,
  resource_type text NOT NULL,
  resource_id text,
  action text NOT NULL,
  details jsonb,
  ip text
);

CREATE INDEX IF NOT EXISTS audit_log_resource_idx ON audit_log (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);

-- RLS posture matches the project model (backend = postgres owner bypasses RLS;
-- no frontend direct access). Enable RLS with no policy → non-owner denied.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Append-only enforcement: block UPDATE/DELETE for every role.
CREATE OR REPLACE FUNCTION audit_log_block_mutations() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutations();

-- Defense in depth: deny mutating grants to non-owner roles (RLS already denies).
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
