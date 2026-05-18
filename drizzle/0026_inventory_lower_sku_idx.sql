-- Supports inventory/order_items joins that compare SKUs case-insensitively.
-- Runtime maintenance also ensures this index for older deployments, but the
-- schema source of truth belongs in migrations.
CREATE INDEX IF NOT EXISTS "inventory_lower_sku_idx"
  ON "inventory" (lower("sku"));

ANALYZE "inventory";
