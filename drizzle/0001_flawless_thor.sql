ALTER TABLE "orders" ADD COLUMN "external_order_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_externalOrderId_unique" UNIQUE("external_order_id");