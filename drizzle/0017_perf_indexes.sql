-- Performance indexes for hot query paths.
--
-- 1. orders (order_status, order_date desc) — every list query filters by
--    status and sorts by order_date desc. Composite index lets Postgres
--    serve "Awaiting Shipment, last 30 days" entirely from the index without
--    a heap scan + sort.
--
-- 2. orders.items GIN — the new expanded search query (commit 545efa2) walks
--    items JSONB looking for sku/name. GIN index makes SKU search ~100x
--    faster on large datasets vs sequential scan.
--
-- 3. shipments (order_id, voided) — used by the
--    awaitingShipmentRealPredicate / fulfillment-deductions exists-check.
--    Composite covers the (orderId AND voided=false) lookup with one index hit.
--
-- 4. orders (client_id, order_status, order_date desc) — filters by client
--    AND status, common when an admin clicks a sidebar entry.
--
-- All CREATE INDEX statements use IF NOT EXISTS so this migration is
-- idempotent and safe to re-run.

CREATE INDEX IF NOT EXISTS "orders_status_date_idx"
  ON "orders" ("order_status", "order_date" desc);

CREATE INDEX IF NOT EXISTS "orders_client_status_date_idx"
  ON "orders" ("client_id", "order_status", "order_date" desc);

CREATE INDEX IF NOT EXISTS "orders_items_gin_idx"
  ON "orders" USING gin ("items");

CREATE INDEX IF NOT EXISTS "shipments_order_voided_idx"
  ON "shipments" ("order_id", "voided");

-- Postgres ANALYZE updates the planner's statistics so it picks the new
-- indexes for query plans immediately.
ANALYZE "orders";
ANALYZE "shipments";
