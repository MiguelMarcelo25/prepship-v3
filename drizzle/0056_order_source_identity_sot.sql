-- PS-388: source identity SOT.
--
-- `orders.external_order_id` is compatibility/display only. New import and sync
-- paths identify source orders by (source_provider, source_account_id,
-- source_order_id). The automatic backfill below is intentionally scoped to
-- non-terminal rows so this migration does not bulk-update historical
-- shipped/cancelled production orders without a separate human-approved data
-- repair.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS source_provider text,
  ADD COLUMN IF NOT EXISTS source_account_id text,
  ADD COLUMN IF NOT EXISTS source_order_id text,
  ADD COLUMN IF NOT EXISTS source_order_number text,
  ADD COLUMN IF NOT EXISTS raw_source_payload jsonb;

UPDATE orders
SET
  source_provider = CASE
    WHEN source_provider IS NOT NULL THEN source_provider
    WHEN external_order_id ~ '^[a-z_]+-.+$' THEN lower(regexp_replace(split_part(external_order_id, '-', 1), '[\s-]+', '_', 'g'))
    WHEN external_order_id ~ '^[0-9]+$' THEN 'shipstation'
    ELSE source_provider
  END,
  source_account_id = CASE
    WHEN source_account_id IS NOT NULL THEN source_account_id
    WHEN external_order_id ~ '^[0-9]+$' AND store_id IS NOT NULL THEN 'store:' || store_id::text
    WHEN external_order_id ~ '^[0-9]+$' THEN 'shipstation-default'
    WHEN external_order_id ~ '^[a-z_]+-.+$' AND store_id IS NOT NULL THEN 'store:' || store_id::text
    WHEN external_order_id ~ '^[a-z_]+-.+$' THEN lower(regexp_replace(split_part(external_order_id, '-', 1), '[\s-]+', '_', 'g')) || ':legacy'
    ELSE source_account_id
  END,
  source_order_id = CASE
    WHEN source_order_id IS NOT NULL THEN source_order_id
    WHEN external_order_id ~ '^[a-z_]+-.+$' THEN substring(external_order_id from '^[a-z_]+-(.+)$')
    WHEN external_order_id ~ '^[0-9]+$' THEN external_order_id
    ELSE source_order_id
  END,
  source_order_number = COALESCE(source_order_number, order_number),
  updated_at = updated_at
WHERE external_order_id IS NOT NULL
  AND order_status NOT IN ('shipped', 'cancelled')
  AND (source_provider IS NULL OR source_account_id IS NULL OR source_order_id IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS "orders_source_unique_idx"
  ON orders (source_provider, source_account_id, source_order_id)
  WHERE source_provider IS NOT NULL
    AND source_account_id IS NOT NULL
    AND source_order_id IS NOT NULL;

-- Bounded compatibility lookup for rows that still lack composite source
-- identity. This is not an authoritative source key for new imports.
CREATE INDEX IF NOT EXISTS "orders_legacy_external_order_id_idx"
  ON orders (external_order_id)
  WHERE external_order_id IS NOT NULL
    AND (
      source_provider IS NULL
      OR source_account_id IS NULL
      OR source_order_id IS NULL
      OR (source_provider = 'shipstation' AND source_account_id = 'shipstation-default')
    );

ALTER TABLE orders DROP CONSTRAINT IF EXISTS "orders_externalOrderId_unique";
DROP INDEX IF EXISTS "orders_externalOrderId_unique";
