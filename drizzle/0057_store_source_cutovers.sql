CREATE TABLE IF NOT EXISTS "store_source_cutovers" (
  "id" serial PRIMARY KEY,
  "client_id" integer NOT NULL REFERENCES "clients"("id"),
  "legacy_provider" text NOT NULL DEFAULT 'shipstation',
  "legacy_store_id" integer NOT NULL,
  "target_provider" text NOT NULL DEFAULT 'shopify',
  "target_store_account_id" integer NOT NULL,
  "mode" text NOT NULL DEFAULT 'active',
  "sync_anchor_at" timestamptz,
  "dry_run_summary" jsonb,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "store_source_cutovers_client_idx"
  ON "store_source_cutovers" ("client_id");

CREATE INDEX IF NOT EXISTS "store_source_cutovers_legacy_idx"
  ON "store_source_cutovers" ("legacy_provider", "legacy_store_id");

CREATE INDEX IF NOT EXISTS "store_source_cutovers_target_idx"
  ON "store_source_cutovers" ("target_provider", "target_store_account_id");

CREATE UNIQUE INDEX IF NOT EXISTS "store_source_cutovers_identity_idx"
  ON "store_source_cutovers" (
    "legacy_provider",
    "legacy_store_id",
    "target_provider",
    "target_store_account_id"
  );

CREATE UNIQUE INDEX IF NOT EXISTS "store_source_cutovers_active_legacy_idx"
  ON "store_source_cutovers" ("legacy_provider", "legacy_store_id")
  WHERE "mode" = 'active';

ALTER TABLE "store_source_cutovers" ENABLE ROW LEVEL SECURITY;
