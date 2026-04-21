CREATE TABLE IF NOT EXISTS "package_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"package_id" integer NOT NULL,
	"change_type" text NOT NULL,
	"qty_delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"note" text,
	"unit_cost" numeric(10, 3),
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "package_ledger" ADD CONSTRAINT "package_ledger_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "package_ledger_package_idx" ON "package_ledger" USING btree ("package_id");