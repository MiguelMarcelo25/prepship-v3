-- PS-414: separate accounting/effective movement time from immutable posted time.
-- Additive only. Existing rows remain untouched and read through created_at fallback.
ALTER TABLE "inventory_ledger" ADD COLUMN IF NOT EXISTS "effective_at" timestamp with time zone;
ALTER TABLE "inventory_ledger" ADD COLUMN IF NOT EXISTS "idempotency_key" text;

CREATE INDEX IF NOT EXISTS "inventory_ledger_effective_at_idx"
  ON "inventory_ledger" USING btree ("effective_at");
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_ledger_idempotency_key_unq"
  ON "inventory_ledger" USING btree ("idempotency_key");
