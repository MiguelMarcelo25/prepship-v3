-- Closes the 16 ERROR-level `rls_disabled_in_public` Supabase advisor findings.
--
-- These 16 tables were the only public tables shipping without row level
-- security. Every other public table in this project (orders, shipments,
-- inventory, and 93 more) already runs RLS enabled with no policies and no
-- FORCE. This migration brings the stragglers in line; it is not a new
-- security model.
--
-- Why this is a no-op for the app:
--   * the API connects as the table owner (postgres) via drizzle, and owners
--     are exempt from RLS unless FORCE ROW LEVEL SECURITY is set (it is not);
--   * server-side supabase-js uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS;
--   * the browser client (web/src/lib/supabase.ts) uses the anon key for auth
--     only -- it never issues PostgREST table reads or realtime subscriptions.
-- So "RLS on, zero policies" means deny-by-default for anon/authenticated,
-- which is the intended posture for this project.
--
-- Applied to production on 2026-08-15 as supabase migration
-- `enable_rls_on_16_public_tables`; this file exists so the repo matches.
-- Re-running is safe: ENABLE ROW LEVEL SECURITY is idempotent.

alter table public.order_lifecycle_events       enable row level security;
alter table public.fulfillment_line_claims      enable row level security;
alter table public.shipment_hazmat_snapshots    enable row level security;
alter table public.order_hazmat_declarations    enable row level security;
alter table public.order_hazmat_materials       enable row level security;
alter table public.hazmat_contacts              enable row level security;
alter table public.automation_rules             enable row level security;
alter table public.automation_rule_versions     enable row level security;
alter table public.automation_rule_conditions   enable row level security;
alter table public.automation_rule_actions      enable row level security;
alter table public.order_automation_state       enable row level security;
alter table public.automation_runs              enable row level security;
alter table public.automation_reprocess_jobs    enable row level security;
alter table public.automation_action_results    enable row level security;
alter table public.automation_outbox            enable row level security;
alter table public.automation_shipping_controls enable row level security;
