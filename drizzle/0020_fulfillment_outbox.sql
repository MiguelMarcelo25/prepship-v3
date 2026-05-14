ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source_provider" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source_account_id" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source_order_id" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source_order_number" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source_status" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "canonical_status" text;

CREATE INDEX IF NOT EXISTS "orders_source_provider_idx" ON "orders" ("source_provider");
CREATE INDEX IF NOT EXISTS "orders_canonical_status_idx" ON "orders" ("canonical_status");

ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "carrier_provider" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "carrier_account_id" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "confirmation_status" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "confirmation_provider" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "confirmation_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "confirmation_last_error" text;
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "marketplace_confirmed_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "shipments_confirmation_status_idx" ON "shipments" ("confirmation_status");

CREATE TABLE IF NOT EXISTS "fulfillment_outbox" (
  "id" serial PRIMARY KEY,
  "order_id" integer NOT NULL,
  "shipment_id" integer,
  "event_type" text NOT NULL,
  "provider" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "next_run_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "fulfillment_outbox_dedupe_idx" ON "fulfillment_outbox" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "fulfillment_outbox_due_idx" ON "fulfillment_outbox" ("status", "next_run_at");
