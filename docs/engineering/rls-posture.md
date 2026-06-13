# RLS posture — the sole wall between the public anon key and customer data (PS-228)

## Model (verified, currently safe)

- The browser bundle ships the **public Supabase anon key**, and PostgREST (the
  Supabase Data API) is reachable at `https://<project>.supabase.co/rest/v1/<table>`.
- The PrepShip app does **not** use PostgREST. All data flows through the **Render
  backend**, which connects as the **postgres owner** — the owner **bypasses RLS**.
  The frontend authenticates with Supabase auth (JWT) and calls the Render API only.
- Every `public` table has **RLS enabled with no policy** (deny-all). For a non-owner
  role (anon / authenticated), RLS therefore denies all reads/writes. This is
  intentional — see the auto-memory `project_supabase_rls_model`: do **not** add open
  policies to "fix" access; the Render API is the only intended data path.
- **Live re-test:** an anon-key PostgREST read of `clients`, `orders`, `carrier_accounts`
  returns `[]` (denied). Re-run this after any RLS change.

## Risk

Because the anon key is public and PostgREST is enabled, a **single mistake** — one
migration disabling RLS, or one overly-permissive policy — is an instant data breach
(orders, clients, shipments, credential metadata). Since the app doesn't rely on
PostgREST, this exposure is pure downside.

## Controls (regression-proofing)

1. **CI guard** `test:ps-228-rls-regression` (in `test:security-readiness`):
   - fails on any `DISABLE ROW LEVEL SECURITY` in a migration,
   - fails on any `CREATE POLICY` (no open policies — deny-all model),
   - fails on any `GRANT … TO anon/public/authenticated`,
   - requires the runtime table-ensure paths to `ENABLE ROW LEVEL SECURITY`.
2. **Supabase advisors** to watch in CI / the dashboard:
   - `rls_disabled_in_public` — a public table without RLS (must be empty),
   - `rls_enabled_no_policy` — informational here; this is our INTENDED deny-all state,
     reviewed (not "fixed" by adding policies).
3. **Defense-in-depth migration** `drizzle/0045_revoke_public_api_grants.sql` —
   revokes anon/authenticated grants on the public schema (idempotent; the owner
   connection is unaffected; apply after confirming PostgREST is unused).

## Acceptance

- A migration that disables RLS on any public table **fails CI** (guard check #1).
- Anon-key PostgREST reads remain **denied** (live re-test of clients/orders).
