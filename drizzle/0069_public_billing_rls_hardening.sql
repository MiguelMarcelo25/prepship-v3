-- Security hardening for billing proof and operational reference-rate backups.
--
-- PrepShip uses its privileged backend database connection for these tables;
-- neither table is a Client Portal/PostgREST source. The intended public-API
-- posture is therefore RLS enabled with no policy, plus explicit grant removal.
-- This migration is idempotent and does not change or delete billing rows.

ALTER TABLE public.billing_storage_proof ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.billing_storage_proof
  FROM PUBLIC, anon, authenticated;

REVOKE ALL PRIVILEGES ON SEQUENCE public.billing_storage_proof_id_seq
  FROM PUBLIC, anon, authenticated;

-- CREATE TABLE AS backups do not inherit RLS. Secure every retained backup
-- created for the 0066 reference-rate identity migration without depending on
-- its timestamp suffix.
DO $$
DECLARE
  backup_table record;
BEGIN
  FOR backup_table IN
    SELECT namespace.nspname AS schema_name, relation.relname AS table_name
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND relation.relname ~ '^billing_ref_rates_backup_0066_'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      backup_table.schema_name,
      backup_table.table_name
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, anon, authenticated',
      backup_table.schema_name,
      backup_table.table_name
    );
  END LOOP;
END
$$;
