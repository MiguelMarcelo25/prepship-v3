ALTER TABLE "inventory" ADD COLUMN "base_unit_qty" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "units_per_pack" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "cu_ft_override" real;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "package_id" integer;