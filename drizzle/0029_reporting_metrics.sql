-- Reporting/read-model schema source of truth.
-- The worker refreshes these tables; runtime code should only verify that
-- migrations have been applied before reading or refreshing metrics.

CREATE TABLE IF NOT EXISTS "reporting_refresh_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "scope" text NOT NULL,
  "status" text NOT NULL,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "finished_at" timestamptz,
  "duration_ms" integer,
  "rows_affected" integer DEFAULT 0 NOT NULL,
  "error" text
);

CREATE INDEX IF NOT EXISTS "reporting_refresh_runs_scope_started_idx"
  ON "reporting_refresh_runs" ("scope", "started_at" DESC);

CREATE TABLE IF NOT EXISTS "daily_sales_metrics" (
  "day" date NOT NULL,
  "client_id" integer DEFAULT 0 NOT NULL,
  "store_id" integer DEFAULT 0 NOT NULL,
  "order_count" integer DEFAULT 0 NOT NULL,
  "shipped_count" integer DEFAULT 0 NOT NULL,
  "cancelled_count" integer DEFAULT 0 NOT NULL,
  "unit_count" numeric(14, 3) DEFAULT 0 NOT NULL,
  "revenue" numeric(14, 2) DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "daily_sales_metrics_pkey" PRIMARY KEY ("day", "client_id", "store_id")
);

CREATE INDEX IF NOT EXISTS "daily_sales_metrics_updated_idx"
  ON "daily_sales_metrics" ("updated_at" DESC);

CREATE TABLE IF NOT EXISTS "sku_velocity_metrics" (
  "sku" text NOT NULL,
  "client_id" integer DEFAULT 0 NOT NULL,
  "sold_7d" integer DEFAULT 0 NOT NULL,
  "sold_30d" integer DEFAULT 0 NOT NULL,
  "velocity_per_day" numeric(12, 4) DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "sku_velocity_metrics_pkey" PRIMARY KEY ("sku", "client_id")
);

CREATE INDEX IF NOT EXISTS "sku_velocity_metrics_updated_idx"
  ON "sku_velocity_metrics" ("updated_at" DESC);

CREATE TABLE IF NOT EXISTS "inventory_risk_metrics" (
  "inventory_id" integer PRIMARY KEY NOT NULL,
  "sku" text NOT NULL,
  "client_id" integer,
  "stock_qty" integer DEFAULT 0 NOT NULL,
  "reorder_level" integer DEFAULT 0 NOT NULL,
  "sold_7d" integer DEFAULT 0 NOT NULL,
  "sold_30d" integer DEFAULT 0 NOT NULL,
  "velocity_per_day" numeric(12, 4) DEFAULT 0 NOT NULL,
  "days_supply" numeric(12, 2),
  "restock_qty" integer DEFAULT 0 NOT NULL,
  "total_received" integer DEFAULT 0 NOT NULL,
  "total_sold_all_time" integer DEFAULT 0 NOT NULL,
  "effective_stock" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "inventory_risk_metrics_client_restock_idx"
  ON "inventory_risk_metrics" ("client_id", "restock_qty" DESC, "sold_30d" DESC);

CREATE INDEX IF NOT EXISTS "inventory_risk_metrics_updated_idx"
  ON "inventory_risk_metrics" ("updated_at" DESC);

CREATE TABLE IF NOT EXISTS "billing_summary_metrics" (
  "client_id" integer NOT NULL,
  "period_from" date NOT NULL,
  "period_to" date NOT NULL,
  "order_count" integer DEFAULT 0 NOT NULL,
  "pick_pack_total" numeric(14, 2) DEFAULT 0 NOT NULL,
  "additional_total" numeric(14, 2) DEFAULT 0 NOT NULL,
  "package_total" numeric(14, 2) DEFAULT 0 NOT NULL,
  "shipping_total" numeric(14, 2) DEFAULT 0 NOT NULL,
  "storage_total" numeric(14, 2) DEFAULT 0 NOT NULL,
  "grand_total" numeric(14, 2) DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "billing_summary_metrics_pkey"
    PRIMARY KEY ("client_id", "period_from", "period_to")
);

CREATE INDEX IF NOT EXISTS "billing_summary_metrics_updated_idx"
  ON "billing_summary_metrics" ("updated_at" DESC);
