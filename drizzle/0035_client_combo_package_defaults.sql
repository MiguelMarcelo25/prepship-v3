-- PS-037: per-client package defaults keyed by exact SKU+qty combination.
-- Non-destructive: new table only. No shipped/cancelled data mutation, no
-- column drops/type changes. Idempotent (IF NOT EXISTS) so it is safe to
-- re-run. comboKey is derived server-side (src/lib/package-combo.ts) and is
-- scoped + unique per client so mixed-SKU clients (e.g. Hugrab) can save a
-- package once per combination without leaking across clients.

CREATE TABLE IF NOT EXISTS "client_combo_package_defaults" (
  "id" serial PRIMARY KEY NOT NULL,
  "client_id" integer NOT NULL,
  "combo_key" text NOT NULL,
  "package_id" integer,
  "package_code" text,
  "length" real,
  "width" real,
  "height" real,
  "weight_oz" real,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "client_combo_package_defaults"
    ADD CONSTRAINT "client_combo_package_defaults_client_id_clients_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "client_combo_package_defaults"
    ADD CONSTRAINT "client_combo_package_defaults_package_id_packages_id_fk"
    FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "client_combo_package_defaults_client_combo_idx"
  ON "client_combo_package_defaults" ("client_id", "combo_key");

CREATE INDEX IF NOT EXISTS "client_combo_package_defaults_client_idx"
  ON "client_combo_package_defaults" ("client_id");
