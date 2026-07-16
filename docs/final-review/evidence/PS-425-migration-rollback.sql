-- PS-425 migration 0068 rollback.
-- Run only as part of a controlled application rollback after stopping Billing
-- generation. Current per-shipment descriptions include shipment lineage, so
-- restoring the prior order/line/description constraint preserves those rows.
BEGIN;

DROP INDEX IF EXISTS billing_li_shipment_unique_idx;
DROP INDEX IF EXISTS billing_li_order_unique_idx;

ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_li_unique UNIQUE (order_id, line_type, description);

COMMIT;
