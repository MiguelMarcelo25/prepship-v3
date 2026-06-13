-- PS-232 — pin a non-mutable search_path on the pgboss SECURITY DEFINER functions.
--
-- Supabase's function_search_path_mutable advisor flags pgboss.create_queue /
-- pgboss.delete_queue (and siblings) because they run SECURITY DEFINER with a
-- mutable search_path. Pin search_path = pgboss, pg_catalog on every function in
-- the pgboss schema so they can't be hijacked via a caller-controlled search_path.
--
-- Idempotent + signature-agnostic (a DO loop resolves each function's exact
-- identity args) and a NO-OP when the pgboss schema doesn't exist (fresh/test DBs
-- where pg-boss hasn't initialized). Safe to re-run.

DO $$
DECLARE
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    FOR r IN
      SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'pgboss'
    LOOP
      EXECUTE format(
        'ALTER FUNCTION pgboss.%I(%s) SET search_path = pgboss, pg_catalog',
        r.proname, r.args
      );
    END LOOP;
  END IF;
END $$;
