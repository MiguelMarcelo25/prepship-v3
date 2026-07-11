-- Per user override unlock shipped data on 2026-07-11: PS-413 additive structured
-- identity for idempotent outbound package consumption.
-- Legacy rows stay untouched; no shipped/cancelled order or shipment rows are mutated.
ALTER TABLE "package_ledger" ADD COLUMN IF NOT EXISTS "shipment_id" integer;
ALTER TABLE "package_ledger" ADD COLUMN IF NOT EXISTS "order_id" integer;
ALTER TABLE "package_ledger" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "package_ledger" ADD COLUMN IF NOT EXISTS "source_account_id" text;
ALTER TABLE "package_ledger" ADD COLUMN IF NOT EXISTS "provider_shipment_id" text;
ALTER TABLE "package_ledger" ADD COLUMN IF NOT EXISTS "effective_at" timestamp with time zone;
ALTER TABLE "package_ledger" ADD COLUMN IF NOT EXISTS "idempotency_key" text;

ALTER TABLE "package_ledger"
  DROP CONSTRAINT IF EXISTS "package_ledger_package_id_packages_id_fk";
ALTER TABLE "package_ledger"
  ADD CONSTRAINT "package_ledger_package_id_packages_id_fk"
  FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS "package_ledger_shipment_idx"
  ON "package_ledger" USING btree ("shipment_id");
CREATE INDEX IF NOT EXISTS "package_ledger_order_idx"
  ON "package_ledger" USING btree ("order_id");
CREATE INDEX IF NOT EXISTS "package_ledger_effective_at_idx"
  ON "package_ledger" USING btree ("effective_at");
CREATE UNIQUE INDEX IF NOT EXISTS "package_ledger_idempotency_key_unq"
  ON "package_ledger" USING btree ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "package_consumption_reviews" (
  "id" serial PRIMARY KEY,
  "shipment_id" integer NOT NULL,
  "order_id" integer,
  "source" text NOT NULL,
  "source_account_id" text,
  "provider_shipment_id" text,
  "effective_at" timestamp with time zone NOT NULL,
  "idempotency_key" text NOT NULL,
  "reason" text NOT NULL,
  "selected_package_ref" text,
  "dims_l" real,
  "dims_w" real,
  "dims_h" real,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "package_consumption_reviews_idempotency_unq"
  ON "package_consumption_reviews" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "package_consumption_reviews_status_idx"
  ON "package_consumption_reviews" ("status", "effective_at");
CREATE INDEX IF NOT EXISTS "package_consumption_reviews_shipment_idx"
  ON "package_consumption_reviews" ("shipment_id");
ALTER TABLE "package_consumption_reviews" ENABLE ROW LEVEL SECURITY;
