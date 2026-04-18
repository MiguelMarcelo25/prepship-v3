CREATE TABLE IF NOT EXISTS "inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer,
	"sku" text NOT NULL,
	"name" text,
	"image_url" text,
	"stock_qty" integer DEFAULT 0 NOT NULL,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"weight_oz" real DEFAULT 0,
	"length" real,
	"width" real,
	"height" real,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_client_sku_unq" UNIQUE("client_id","sku")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"inventory_id" integer NOT NULL,
	"type" text NOT NULL,
	"qty" integer NOT NULL,
	"order_id" integer,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory" ADD CONSTRAINT "inventory_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_inventory_id_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_client_idx" ON "inventory" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_sku_idx" ON "inventory" USING btree ("sku");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_ledger_inv_idx" ON "inventory_ledger" USING btree ("inventory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_ledger_created_idx" ON "inventory_ledger" USING btree ("created_at");