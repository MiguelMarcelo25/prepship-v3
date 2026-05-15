-- Hot-path indexes for GET /orders.
--
-- These are intentionally idempotent so the Render/Supabase database can be
-- repaired safely if the migration is re-run. The Orders page filters by
-- status/date and then enriches the visible page with the latest shipment per
-- order; without the two shipment "latest" indexes Postgres can sort a much
-- larger shipment set than the operator actually needs.

CREATE INDEX IF NOT EXISTS "orders_status_date_id_idx"
  ON "orders" ("order_status", "order_date" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "orders_store_status_date_idx"
  ON "orders" ("store_id", "order_status", "order_date" DESC)
  WHERE "store_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "shipments_order_latest_idx"
  ON "shipments" ("order_id", "id" DESC)
  WHERE "order_id" IS NOT NULL AND coalesce("voided", false) = false;

CREATE INDEX IF NOT EXISTS "shipments_order_number_latest_idx"
  ON "shipments" ("order_number", "id" DESC)
  WHERE "order_number" IS NOT NULL AND "order_id" IS NULL AND coalesce("voided", false) = false;

ANALYZE "orders";
ANALYZE "shipments";
