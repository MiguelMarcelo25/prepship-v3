-- Store marketplace order schema source of truth.
-- Walmart/eBay compatibility handlers write to this table, but runtime code
-- should only verify the migration is present instead of creating schema.

CREATE TABLE IF NOT EXISTS "store_orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "carrier_account_id" integer NOT NULL,
  "provider" text NOT NULL,
  "external_order_id" text NOT NULL,
  "customer_order_id" text,
  "order_date" timestamptz,
  "source_status" text,
  "ship_to" jsonb,
  "items" jsonb,
  "totals" jsonb,
  "raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "shipment_status" text DEFAULT 'unshipped' NOT NULL,
  "tracking_number" text,
  "tracking_carrier" text,
  "shipped_at" timestamptz,
  "first_fetched_at" timestamptz DEFAULT now() NOT NULL,
  "last_fetched_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE "store_orders"
  ADD COLUMN IF NOT EXISTS "carrier_account_id" integer,
  ADD COLUMN IF NOT EXISTS "provider" text,
  ADD COLUMN IF NOT EXISTS "external_order_id" text,
  ADD COLUMN IF NOT EXISTS "customer_order_id" text,
  ADD COLUMN IF NOT EXISTS "order_date" timestamptz,
  ADD COLUMN IF NOT EXISTS "source_status" text,
  ADD COLUMN IF NOT EXISTS "ship_to" jsonb,
  ADD COLUMN IF NOT EXISTS "items" jsonb,
  ADD COLUMN IF NOT EXISTS "totals" jsonb,
  ADD COLUMN IF NOT EXISTS "raw" jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "shipment_status" text DEFAULT 'unshipped',
  ADD COLUMN IF NOT EXISTS "tracking_number" text,
  ADD COLUMN IF NOT EXISTS "tracking_carrier" text,
  ADD COLUMN IF NOT EXISTS "shipped_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "first_fetched_at" timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "last_fetched_at" timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS "store_orders_provider_external_idx"
  ON "store_orders" ("provider", "external_order_id");

CREATE INDEX IF NOT EXISTS "store_orders_carrier_account_idx"
  ON "store_orders" ("carrier_account_id");

CREATE INDEX IF NOT EXISTS "store_orders_last_fetched_at_idx"
  ON "store_orders" ("last_fetched_at" DESC);

CREATE INDEX IF NOT EXISTS "store_orders_shipment_status_idx"
  ON "store_orders" ("shipment_status");

ALTER TABLE "store_orders" ENABLE ROW LEVEL SECURITY;
