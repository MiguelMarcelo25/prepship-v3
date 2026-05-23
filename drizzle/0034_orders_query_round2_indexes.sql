-- PS-030: targeted /orders query round-2 indexes.
-- Non-destructive: no shipped/cancelled data mutation, no column drops/type changes.

CREATE INDEX IF NOT EXISTS "orders_store_status_date_id_idx"
  ON "orders" ("store_id", "order_status", "order_date" DESC, "id" DESC)
  WHERE "store_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "orders_client_status_date_id_idx"
  ON "orders" ("client_id", "order_status", "order_date" DESC, "id" DESC)
  WHERE "client_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "clients_test_client_id_idx"
  ON "clients" ("id")
  WHERE "is_test" = true;

CREATE INDEX IF NOT EXISTS "clients_active_client_id_idx"
  ON "clients" ("id")
  WHERE coalesce("active", true) = true;

ANALYZE "orders";
ANALYZE "clients";
