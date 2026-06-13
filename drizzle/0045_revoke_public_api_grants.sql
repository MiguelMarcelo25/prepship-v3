-- PS-228 — defense-in-depth: revoke PostgREST/Data-API role grants on the public schema.
--
-- The browser ships the public Supabase anon key and PostgREST is reachable, so RLS
-- deny-all is the SOLE control between that key and customer data. The app does NOT
-- use PostgREST — all data flows through the Render backend on a privileged (owner)
-- connection that bypasses RLS. So the anon/authenticated table grants are pure
-- downside: revoking them is belt-and-suspenders behind RLS.
--
-- Idempotent + non-breaking: REVOKE of a grant a role doesn't hold is a no-op, and
-- the owner connection is unaffected. Apply via the normal migration process AFTER
-- confirming PostgREST is unused (it is). RLS remains the primary control regardless.

-- Future tables in this schema also default to no API-role grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Existing objects.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
REVOKE USAGE ON SCHEMA public FROM anon, authenticated;
