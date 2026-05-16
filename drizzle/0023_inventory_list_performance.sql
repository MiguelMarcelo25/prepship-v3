-- Inventory page quick-win indexes.
-- The Stock Levels page now asks for one server page at a time, ordered by
-- updated_at, and commonly filters by client + active/deactivated mode.
CREATE INDEX IF NOT EXISTS "inventory_active_updated_idx"
  ON "inventory" ("active", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "inventory_client_active_updated_idx"
  ON "inventory" ("client_id", "active", "updated_at" DESC)
  WHERE "client_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "inventory_ledger_inv_type_idx"
  ON "inventory_ledger" ("inventory_id", "type");

ANALYZE "inventory";
ANALYZE "inventory_ledger";
