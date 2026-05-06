-- ============================================================================
-- Security hardening — resolves Supabase Security Advisor findings
-- ============================================================================
-- Apply via Supabase Dashboard → SQL Editor → paste this file → Run.
-- (Or `psql $DATABASE_URL -f drizzle/0018_security_hardening.sql` if you
-- prefer CLI.)
--
-- WHAT THIS DOES & WHY IT'S SAFE:
--
-- 1. ENABLE RLS on 24 public tables. The frontend uses Supabase ONLY for
--    `auth.*` (signin/session) — it NEVER does direct `.from(table)` queries.
--    All data access goes through the Hono backend, which uses the SERVICE
--    ROLE key (which BYPASSES RLS entirely). So enabling RLS with no policies
--    locks out the public anon key without breaking the backend.
--
-- 2. ADD PRIMARY KEY to client_package_prices (currently only a non-unique
--    index covers the same columns). Drops the now-redundant index after.
--
-- 3. ADD INDEXES for unindexed FKs. Improves JOIN/CASCADE-DELETE perf.
--
-- 4. The "Unused Index" warnings are NOT addressed here — they need real
--    traffic data to validate before dropping. See README at bottom.
--
-- 5. Auth toggles ("Leaked Password Protection", "Absolute Connection
--    Strategy") are dashboard-only — see README at bottom.
--
-- Idempotent: safe to re-run.
-- ============================================================================


-- ─── 1. RLS: lock down the 24 public tables (deny-all from anon) ────────────
-- ALTER TABLE … ENABLE ROW LEVEL SECURITY without any CREATE POLICY = the
-- anon key gets nothing. Service role still gets full access (it bypasses RLS).

ALTER TABLE public.sku_qty_dims           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_ledger       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_ref_rates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_skus            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_line_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.print_queue_orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_package_prices  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packages               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_ledger         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_defaults       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_meta              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_config         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mock_labels            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_labels          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_sku_parents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_cache             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_overrides        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipments              ENABLE ROW LEVEL SECURITY;

-- These three were already RLS-enabled-no-policy (correctly). The advisor
-- flags them because intent is ambiguous; they're now consistent with the
-- rest of the schema, which IS the intent: backend-only access via service
-- role key.
-- public.carrier_accounts  — already enabled
-- public.store_accounts    — already enabled
-- public.store_orders      — already enabled


-- ─── 2. PRIMARY KEY for client_package_prices ───────────────────────────────
-- Schema currently has only `index('client_package_prices_pk_idx')` — that's
-- a non-unique index, so duplicate (client_id, package_id) pairs are possible
-- and Postgres can't enforce uniqueness. Promote to a true PRIMARY KEY.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.client_package_prices'::regclass
      AND contype = 'p'
  ) THEN
    -- If you have existing duplicates, this will FAIL. Run this first to find them:
    --   SELECT client_id, package_id, COUNT(*) FROM client_package_prices
    --   GROUP BY client_id, package_id HAVING COUNT(*) > 1;
    -- Then dedupe before applying the PK.
    ALTER TABLE public.client_package_prices
      ADD CONSTRAINT client_package_prices_pkey
      PRIMARY KEY (client_id, package_id);

    -- The PK creates its own unique index; the old non-unique one is redundant.
    DROP INDEX IF EXISTS public.client_package_prices_pk_idx;
  END IF;
END $$;


-- ─── 3. INDEXES for unindexed foreign keys ──────────────────────────────────
-- billing_line_items.shipment_id and .order_id, and inventory_ledger.order_id
-- are FKs but have no covering index → slow JOINs and slow CASCADE deletes.

CREATE INDEX IF NOT EXISTS billing_li_shipment_idx
  ON public.billing_line_items (shipment_id)
  WHERE shipment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_li_order_idx
  ON public.billing_line_items (order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_ledger_order_idx
  ON public.inventory_ledger (order_id)
  WHERE order_id IS NOT NULL;
-- The `WHERE … IS NOT NULL` makes these PARTIAL indexes — they skip rows where
-- the FK is NULL, which is most of them for nullable FKs. Smaller index,
-- faster writes, same JOIN performance for the rows that matter.


-- ============================================================================
-- WHAT'S LEFT (NOT in this migration — needs your decision):
--
-- ● Auth → Leaked Password Protection
--   Dashboard: Authentication → Providers → Email
--   Toggle: "Check passwords against HaveIBeenPwned database"
--   Free, instant, recommended.
--
-- ● Auth → Absolute Connection Management Strategy
--   Dashboard: Authentication → Sessions
--   Toggle: enable absolute session timeout
--   Recommended for stricter security; sessions expire on a hard schedule
--   regardless of activity.
--
-- ● Unused Index warnings (8 indexes flagged)
--   DO NOT drop these blindly. Postgres' usage stats can be reset, and a
--   newly-created index legitimately shows zero usage until traffic exercises
--   the relevant query path. Verify with:
--
--     SELECT schemaname, relname AS table, indexrelname AS index, idx_scan
--     FROM pg_stat_user_indexes
--     WHERE schemaname = 'public' AND idx_scan = 0
--     ORDER BY relname;
--
--   Wait at least 2-4 weeks of production traffic. Then drop only those still
--   showing idx_scan = 0 AND not backing a unique constraint AND not used by
--   any planned queries.
-- ============================================================================
