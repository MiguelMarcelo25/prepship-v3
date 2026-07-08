-- Phase 2 of the 2026-07-08 API performance audit
-- (docs/api-performance-audit-2026-07-08.md). Additive indexes only — no
-- semantic change to any query. Each index matches an expression/predicate a
-- hot route emits verbatim, proven against production EXPLAIN plans:
--
-- 1. orders_effective_status_date_id_idx — the /orders status filter is the
--    orderLifecycleEffectiveStatusSql() CASE (order-lifecycle-status.ts:223),
--    which no plain-column index can serve. Production before-plan: Seq Scan,
--    178ms warm, and a catastrophic row misestimate (est. 350 vs actual
--    29,291) that poisons join planning in every query using the predicate.
--    The expression index serves the filter AND gives the planner real
--    statistics on the expression.
--
-- 2. billing_line_items_shipping_shipment_idx — /billing/shipping-margin's
--    `bli` derived table (shipping-margin-analytics.ts:527-534) aggregates
--    ALL shipping line items on every call. Before-plan: Seq Scan (22,044 of
--    70,402 rows) + 10MB HashAggregate, 43ms warm. Covering partial makes it
--    an index-only scan of exactly the shipping subset.
--
-- 3. shipments_provider_account_nickname_idx — the `provider_account_names`
--    derived table (shipping-margin-analytics.ts:517-524) groups ALL
--    shipments by provider_account_id on every call; also serves nickname
--    lookups. Partial predicate matches the subquery's WHERE verbatim.
--
-- 4. shipments_effective_shipped_at_idx — /billing/shipping-margin filters
--    AND sorts on coalesce(ship_date, label_ship_date, label_created_at,
--    create_date, created_at) (shipping-margin-analytics.ts:480-486); all
--    five columns are timestamptz so the expression is immutable. Partial
--    predicates match the query's constant voided/is_return filters.
--
-- Deliberately NOT indexed (measured, would be dead or unusable):
--   - billing_line_items (client_id, ship_date[, created_at]) — the watermark
--     aggregate already runs at 4.7ms via billing_li_date_idx.
--   - pg_trgm GIN for global search — the search WHERE is a 12-branch OR
--     including JSON extractions and id::text; Postgres can only use indexes
--     for an OR when every branch is indexable, so GINs alone cannot change
--     the plan. Needs the Phase 3 query reshape first.
--   - billingShipDateSql (billing.ts:186-204) — spans two tables and casts
--     JSON text to timestamp (not immutable); cannot be expression-indexed.
--     Phase 3 query-shape fix.
--
-- NOTE: applied to production out-of-band via the Supabase SQL editor using
-- CREATE INDEX CONCURRENTLY (this file is the idempotent record; IF NOT
-- EXISTS makes re-runs no-ops).

CREATE INDEX IF NOT EXISTS orders_effective_status_date_id_idx ON public.orders (
  (case
    when lower(coalesce(order_status, '')) = 'cancelled' then 'cancelled'
    when lower(coalesce(canonical_status, '')) = 'cancelled' then 'cancelled'
    when lower(coalesce(order_status, '')) = 'shipped' then 'shipped'
    when coalesce(externally_shipped, false) = true then 'shipped'
    else coalesce(nullif(lower(order_status), ''), 'awaiting_shipment')
  end),
  order_date desc,
  id desc
);

CREATE INDEX IF NOT EXISTS billing_line_items_shipping_shipment_idx
  ON public.billing_line_items (shipment_id)
  INCLUDE (client_id, id, total_cost)
  WHERE line_type = 'shipping';

CREATE INDEX IF NOT EXISTS shipments_provider_account_nickname_idx
  ON public.shipments (provider_account_id)
  INCLUDE (provider_account_nickname)
  WHERE provider_account_id IS NOT NULL
    AND nullif(btrim(provider_account_nickname), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS shipments_effective_shipped_at_idx
  ON public.shipments (
    (coalesce(ship_date, label_ship_date, label_created_at, create_date, created_at)) desc,
    id desc
  )
  WHERE coalesce(voided, false) = false
    AND coalesce(is_return, false) = false;
