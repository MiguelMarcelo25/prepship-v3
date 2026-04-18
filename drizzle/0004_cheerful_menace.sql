CREATE TABLE IF NOT EXISTS "billing_config" (
	"client_id" integer PRIMARY KEY NOT NULL,
	"pick_pack_fee" numeric(10, 2) DEFAULT '0' NOT NULL,
	"additional_unit_fee" numeric(10, 2) DEFAULT '0' NOT NULL,
	"package_cost_markup" numeric(5, 2) DEFAULT '0' NOT NULL,
	"shipping_markup_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"shipping_markup_flat" numeric(10, 2) DEFAULT '0' NOT NULL,
	"billing_mode" text DEFAULT 'per_shipment' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"order_id" integer,
	"order_number" text,
	"shipment_id" integer,
	"ship_date" timestamp with time zone,
	"line_type" text NOT NULL,
	"description" text NOT NULL,
	"qty" numeric(10, 2) DEFAULT '1' NOT NULL,
	"unit_cost" numeric(10, 2) NOT NULL,
	"total_cost" numeric(10, 2) NOT NULL,
	"invoiced" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_li_unique" UNIQUE("order_id","line_type","description")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_config" ADD CONSTRAINT "billing_config_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_line_items" ADD CONSTRAINT "billing_line_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_line_items" ADD CONSTRAINT "billing_line_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_line_items" ADD CONSTRAINT "billing_line_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_li_client_idx" ON "billing_line_items" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_li_date_idx" ON "billing_line_items" USING btree ("ship_date");