-- Credential account schema source of truth.
-- Production schema belongs in migrations. Data cutover is owned by migration 0063.

CREATE TABLE IF NOT EXISTS "store_accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "client_id" integer,
  "provider" text NOT NULL,
  "label" text,
  "account_identifier" text,
  "credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source" text DEFAULT 'admin' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "store_accounts_client_provider_account_idx"
  ON "store_accounts" USING btree (
    COALESCE("client_id", -1),
    "provider",
    COALESCE("account_identifier", '')
  );

CREATE TABLE IF NOT EXISTS "carrier_account_clients" (
  "carrier_account_id" integer NOT NULL,
  "client_id" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "carrier_account_clients_pkey"
    PRIMARY KEY ("carrier_account_id", "client_id"),
  CONSTRAINT "carrier_account_clients_account_fk"
    FOREIGN KEY ("carrier_account_id")
    REFERENCES "carrier_accounts"("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "carrier_account_clients_client_idx"
  ON "carrier_account_clients" USING btree ("client_id");

ALTER TABLE "store_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carrier_account_clients" ENABLE ROW LEVEL SECURITY;
