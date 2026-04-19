CREATE TABLE IF NOT EXISTS "print_queue_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"order_id" text NOT NULL,
	"order_number" text,
	"label_url" text NOT NULL,
	"sku_group_id" text NOT NULL,
	"primary_sku" text,
	"item_description" text,
	"order_qty" integer DEFAULT 1 NOT NULL,
	"multi_sku_data" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"print_count" integer DEFAULT 0 NOT NULL,
	"last_printed_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_queue_order_client_unq" UNIQUE("order_id","client_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_queue_client_status_idx" ON "print_queue_orders" USING btree ("client_id","status");