CREATE TABLE IF NOT EXISTS "inventory_sku_parents" (
	"inventory_id" integer NOT NULL,
	"parent_sku_id" integer NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_sku_parents_inventory_id_parent_sku_id_pk" PRIMARY KEY("inventory_id","parent_sku_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "return_labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"return_shipment_id" integer,
	"return_tracking_number" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mock_labels" (
	"shipment_id" integer PRIMARY KEY NOT NULL,
	"order_number" text,
	"tracking_number" text NOT NULL,
	"service_label" text,
	"weight_oz" numeric(10, 2),
	"ship_from" text,
	"ship_to" text,
	"ship_date" text,
	"pdf_base64" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_defaults" (
	"sku" text PRIMARY KEY NOT NULL,
	"weight_oz" numeric(10, 3),
	"length" numeric(10, 3),
	"width" numeric(10, 3),
	"height" numeric(10, 3),
	"default_package_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_sku_parents" ADD CONSTRAINT "inventory_sku_parents_inventory_id_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_sku_parents" ADD CONSTRAINT "inventory_sku_parents_parent_sku_id_parent_skus_id_fk" FOREIGN KEY ("parent_sku_id") REFERENCES "public"."parent_skus"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_labels" ADD CONSTRAINT "return_labels_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_labels" ADD CONSTRAINT "return_labels_return_shipment_id_shipments_id_fk" FOREIGN KEY ("return_shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_sku_parents_parent_idx" ON "inventory_sku_parents" USING btree ("parent_sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_sku_parents_primary_uq" ON "inventory_sku_parents" USING btree ("inventory_id") WHERE "inventory_sku_parents"."is_primary" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_labels_shipment_idx" ON "return_labels" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_labels_return_idx" ON "return_labels" USING btree ("return_shipment_id");