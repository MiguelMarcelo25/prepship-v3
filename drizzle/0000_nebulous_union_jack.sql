CREATE TABLE IF NOT EXISTS "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"store_ids" integer[] DEFAULT '{}' NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"ss_api_key" text,
	"ss_api_secret" text,
	"ss_api_key_v2" text,
	"rate_source_client_id" integer,
	"brand_name" text,
	"brand_color" text,
	"brand_logo" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_overrides" (
	"order_id" integer PRIMARY KEY NOT NULL,
	"residential" boolean,
	"tracking_number" text,
	"notes" text DEFAULT '',
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ref_usps_rate" text,
	"ref_ups_rate" text,
	"rate_weight_oz" real,
	"rate_dims_l" real,
	"rate_dims_w" real,
	"rate_dims_h" real,
	"selected_pid" integer,
	"selected_package_id" text,
	"best_rate_json" jsonb,
	"best_rate_at" timestamp with time zone,
	"best_rate_dims" text,
	"shipping_account" text,
	"externally_shipped_source" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer,
	"order_number" text NOT NULL,
	"order_status" text DEFAULT 'awaiting_shipment' NOT NULL,
	"order_date" timestamp with time zone,
	"store_id" integer,
	"customer_email" text,
	"ship_to_name" text,
	"ship_to_city" text,
	"ship_to_state" text,
	"ship_to_postal_code" text,
	"carrier_code" text,
	"service_code" text,
	"weight_oz" real,
	"order_total" numeric(10, 2) DEFAULT '0' NOT NULL,
	"shipping_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"externally_shipped" boolean DEFAULT false NOT NULL,
	"externally_fulfilled_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer,
	"client_id" integer,
	"order_number" text,
	"carrier_code" text,
	"service_code" text,
	"tracking_number" text,
	"ship_date" timestamp with time zone,
	"create_date" timestamp with time zone,
	"weight_oz" real,
	"dims_l" real,
	"dims_w" real,
	"dims_h" real,
	"cost" numeric(10, 2),
	"other_cost" numeric(10, 2) DEFAULT '0' NOT NULL,
	"label_url" text,
	"label_created_at" timestamp with time zone,
	"label_format" text,
	"label_carrier" text,
	"label_service" text,
	"label_tracking" text,
	"label_cost" numeric(10, 2),
	"label_ship_date" timestamp with time zone,
	"label_provider" integer,
	"label_shipment_id" integer,
	"selected_rate_json" jsonb,
	"selected_pid" integer,
	"selected_package_id" text,
	"provider_account_id" integer,
	"provider_account_nickname" text,
	"voided" boolean DEFAULT false NOT NULL,
	"source" text,
	"is_return" boolean DEFAULT false NOT NULL,
	"return_for_shipment_id" integer,
	"return_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'box' NOT NULL,
	"length" real DEFAULT 0 NOT NULL,
	"width" real DEFAULT 0 NOT NULL,
	"height" real DEFAULT 0 NOT NULL,
	"tare_weight_oz" real DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"carrier_code" text,
	"package_code" text,
	"domestic" boolean,
	"international" boolean,
	"stock_qty" integer DEFAULT 0 NOT NULL,
	"reorder_level" integer DEFAULT 10 NOT NULL,
	"unit_cost" numeric(10, 2),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku" text,
	"name" text,
	"image_url" text,
	"weight_oz" real DEFAULT 0 NOT NULL,
	"length" real DEFAULT 0 NOT NULL,
	"width" real DEFAULT 0 NOT NULL,
	"height" real DEFAULT 0 NOT NULL,
	"default_package_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sku_qty_dims" (
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"length" real,
	"width" real,
	"height" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_qty_dims_sku_qty_pk" PRIMARY KEY("sku","qty")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"weight_oz" real,
	"to_zip" text,
	"rates" jsonb NOT NULL,
	"best_rate" jsonb,
	"weight_version" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_overrides" ADD CONSTRAINT "order_overrides_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipments" ADD CONSTRAINT "shipments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders" USING btree ("order_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_client_idx" ON "orders" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_store_idx" ON "orders" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_date_idx" ON "orders" USING btree ("order_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_client_idx" ON "shipments" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_date_idx" ON "shipments" USING btree ("ship_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_cache_weight_zip_idx" ON "rate_cache" USING btree ("weight_oz","to_zip");