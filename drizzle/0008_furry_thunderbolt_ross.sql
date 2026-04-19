CREATE TABLE IF NOT EXISTS "billing_ref_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"weight_oz" integer,
	"zip_to" text,
	"carrier" text,
	"service" text,
	"cost" numeric(10, 2),
	"source" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_package_prices" (
	"client_id" integer NOT NULL,
	"package_id" integer NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_package_prices" ADD CONSTRAINT "client_package_prices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_ref_rates_lookup_idx" ON "billing_ref_rates" USING btree ("weight_oz","zip_to","carrier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_package_prices_pk_idx" ON "client_package_prices" USING btree ("client_id","package_id");