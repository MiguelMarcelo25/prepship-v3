-- PS-220 — per-client opt-in for the SHIPP house-account margin model. Additive column on the
-- existing billing_config (not locked). Default false ⇒ every client unaffected until DJ enables
-- it. Intentionally NOT declared on the drizzle billing_config schema: a bare
-- db.select().from(billingConfig) would otherwise emit this column and 500 prod before this
-- migration runs. It is read/written via raw SQL (house-account-opt-in.ts) instead.
ALTER TABLE billing_config ADD COLUMN IF NOT EXISTS house_account_enabled boolean NOT NULL DEFAULT false;
