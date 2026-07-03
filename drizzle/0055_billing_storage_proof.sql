-- PS-373 (slice 2): frozen per-period storage-billing PROOF sidecar.
-- The single `storage` billing_line_items row holds only a display total + a
-- short description (which is part of the line's onConflict unique key), so the
-- structured per-SKU / per-interval evidence a client dispute or admin audit
-- needs has nowhere to live. This additive sidecar freezes
-- computeClientStorageBilling()'s full proof at generate time, keyed by the
-- billing PERIOD (client_id + canonical UTC-midnight [period_start, period_end)
-- bounds). No coupling to orders/shipments; upserted per client+period on each
-- Update Billing. Additive-only — no shipped/cancelled data touched.
CREATE TABLE IF NOT EXISTS "billing_storage_proof" (
  "id" serial PRIMARY KEY NOT NULL,
  "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "days_in_month" integer NOT NULL,
  "monthly_rate_per_cu_ft" numeric(10, 4) NOT NULL,
  "daily_rate_per_cu_ft" numeric(18, 10) NOT NULL,
  "total_cu_ft_days" numeric(18, 6) NOT NULL,
  "amount" numeric(10, 2) NOT NULL,
  "sku_count" integer NOT NULL,
  "exception_count" integer NOT NULL,
  "proof" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "billing_storage_proof_client_period_unq" UNIQUE ("client_id", "period_start", "period_end")
);
