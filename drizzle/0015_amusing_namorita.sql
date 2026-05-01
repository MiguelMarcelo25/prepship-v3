CREATE TABLE IF NOT EXISTS "carrier_accounts" (
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
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "carrier_accounts_client_provider_account_idx" ON "carrier_accounts" USING btree (COALESCE("client_id", -1),"provider",COALESCE("account_identifier", ''));