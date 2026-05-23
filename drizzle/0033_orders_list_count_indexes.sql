-- PS-029: read-only performance indexes for /orders list/count hot paths.
-- Non-destructive: no shipped/cancelled data mutation, no column drops/type changes.

CREATE INDEX IF NOT EXISTS "orders_walmart_shipstation_order_number_idx"
  ON "orders" ("order_number", "id")
  WHERE "store_id" = 376661;

CREATE INDEX IF NOT EXISTS "orders_walmart_direct_order_number_latest_idx"
  ON "orders" ("order_number", "order_date" DESC, "id" DESC)
  WHERE "store_id" = 9000001;

ANALYZE "orders";
