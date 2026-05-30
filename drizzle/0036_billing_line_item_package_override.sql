-- PS — Billing: per-line package override so the "Edit Billing Detail" modal
-- can change a row's Box Size + Box Cost WITHOUT mutating the shipment's
-- selectedPackageId (billing-line-only edit). When set, billingDetails uses
-- this package for the box name/dims instead of the shipment-derived package.
-- Non-destructive, idempotent: new nullable column + FK only.

ALTER TABLE "billing_line_items" ADD COLUMN IF NOT EXISTS "package_id" integer;

DO $$ BEGIN
  ALTER TABLE "billing_line_items"
    ADD CONSTRAINT "billing_line_items_package_id_packages_id_fk"
    FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
