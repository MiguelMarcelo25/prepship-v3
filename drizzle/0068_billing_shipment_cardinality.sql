-- PS-425: generated billing is explicitly per active outbound shipment.
-- Existing rows already satisfy this wider key because the previous key was
-- stricter. No billing rows are regenerated or rewritten by this migration.
ALTER TABLE billing_line_items
  DROP CONSTRAINT IF EXISTS billing_li_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS billing_li_shipment_unique_idx
  ON billing_line_items (order_id, shipment_id, line_type, description)
  WHERE shipment_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS billing_li_order_unique_idx
  ON billing_line_items (order_id, line_type, description)
  WHERE order_id IS NOT NULL AND shipment_id IS NULL;
