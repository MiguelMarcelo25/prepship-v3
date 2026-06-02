-- ============================================================================
-- 0037 — Enable RLS on public tables flagged "RLS Disabled in Public" (CRITICAL)
-- ============================================================================
-- These tables were added after the 0018 security-hardening batches and never
-- had row-level security enabled, so the Supabase advisor flags them CRITICAL:
-- without RLS they are reachable through the auto-generated PostgREST Data API
-- under the anon / authenticated roles.
--
-- This app does NOT use PostgREST for data: the backend connects directly as
-- the `postgres` owner role (postgres-js, see src/db/client.ts) and the web app
-- uses Supabase only for auth (supabase.auth.*), never `.from('<table>')`.
-- Therefore ENABLE ROW LEVEL SECURITY with NO policy is the intended secure
-- state — it denies the anon/authenticated PostgREST roles while the owner role
-- continues to bypass RLS. This matches the existing 0018a/b/c convention.
--
-- IMPORTANT: ENABLE only, never FORCE. `FORCE ROW LEVEL SECURITY` would subject
-- the owner role to RLS too and, with no policies, deny the backend all access.
--
-- Idempotent: ALTER ... ENABLE ROW LEVEL SECURITY is a no-op if already enabled.
-- Paste into the Supabase SQL editor and Run, or apply via
-- `npx tsx scripts/rls-advisor-apply.ts`.
-- ============================================================================

ALTER TABLE public.reporting_refresh_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_cache               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_outbox            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_sales_metrics           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sku_velocity_metrics          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_risk_metrics        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_summary_metrics       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_combo_package_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_shipments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_items                 ENABLE ROW LEVEL SECURITY;
