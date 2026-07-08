-- Phase 3 slice 2 of the 2026-07-08 API performance audit
-- (docs/api-performance-audit-2026-07-08.md): trigram indexes for the
-- reshaped global order search.
--
-- The /orders search predicate was a single 14-branch OR (incl. two EXISTS
-- subqueries) — unindexable as a unit, so every search seq-scanned the 415MB
-- orders table (19-51s measured in pg_stat_statements). The route now probes
-- each branch separately via `orders.id IN (UNION ALL ...)` (src/routes/
-- orders.ts), and these indexes give every expensive probe an index path.
--
-- Deliberately NOT indexed (measured/reasoned):
--   - ship_to_city / ship_to_state / ship_to_postal_code — short,
--     low-selectivity text; their probe branches are narrow-column scans
--     (~10-20ms warm) and trigram indexes on 2-char terms are useless anyway.
--   - id::text — served by the pkey via an index-only scan; a trgm index on
--     a cast of the pkey isn't worth its write cost.
--
-- Write-amplification tradeoff (accepted deliberately): 12 GIN indexes add
-- maintenance cost to order/shipment sync writes. GIN fastupdate buffers
-- this, and search was effectively unusable (20-50s) without them.
--
-- NOTE: applied to production out-of-band via the Supabase SQL editor with
-- CREATE INDEX CONCURRENTLY; this file is the idempotent record.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- orders: plain text columns the search probes
CREATE INDEX IF NOT EXISTS orders_order_number_trgm_idx
  ON public.orders USING gin (order_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_external_order_id_trgm_idx
  ON public.orders USING gin (external_order_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_ship_to_name_trgm_idx
  ON public.orders USING gin (ship_to_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_customer_email_trgm_idx
  ON public.orders USING gin (customer_email gin_trgm_ops);

-- orders: raw-JSON extracts (expression GINs matching the probe branches verbatim)
CREATE INDEX IF NOT EXISTS orders_raw_customer_username_trgm_idx
  ON public.orders USING gin ((raw->>'customerUsername') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_raw_ship_to_company_trgm_idx
  ON public.orders USING gin ((raw->'shipTo'->>'company') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_raw_ship_to_street1_trgm_idx
  ON public.orders USING gin ((raw->'shipTo'->>'street1') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_raw_ship_to_street2_trgm_idx
  ON public.orders USING gin ((raw->'shipTo'->>'street2') gin_trgm_ops);

-- order_items: sku/name probe
CREATE INDEX IF NOT EXISTS order_items_sku_trgm_idx
  ON public.order_items USING gin (sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS order_items_name_trgm_idx
  ON public.order_items USING gin (name gin_trgm_ops);

-- shipments: tracking probes
CREATE INDEX IF NOT EXISTS shipments_tracking_number_trgm_idx
  ON public.shipments USING gin (tracking_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS shipments_label_tracking_trgm_idx
  ON public.shipments USING gin (label_tracking gin_trgm_ops);

-- the order_number-linked tracking arm joins orders by order_number, which
-- until now only had store-scoped partial indexes
CREATE INDEX IF NOT EXISTS orders_order_number_idx
  ON public.orders USING btree (order_number);
