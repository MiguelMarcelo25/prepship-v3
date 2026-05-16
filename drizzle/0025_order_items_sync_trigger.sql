CREATE UNIQUE INDEX IF NOT EXISTS "order_items_order_line_idx"
  ON "order_items" ("order_id", "line_index");

CREATE INDEX IF NOT EXISTS "analytics_cache_expires_idx"
  ON "analytics_cache" ("expires_at");

CREATE OR REPLACE FUNCTION prepship_refresh_order_items_for_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM order_items WHERE order_id = NEW.id;

  INSERT INTO order_items (
    order_id,
    line_index,
    sku,
    name,
    quantity,
    unit_price,
    line_total,
    image_url,
    client_id,
    store_id,
    order_status,
    order_date,
    updated_at
  )
  SELECT
    NEW.id,
    normalized.line_index,
    normalized.sku,
    normalized.name,
    normalized.quantity,
    normalized.unit_price,
    coalesce(normalized.explicit_line_total, normalized.unit_price * normalized.quantity),
    normalized.image_url,
    NEW.client_id,
    NEW.store_id,
    NEW.order_status,
    NEW.order_date,
    now()
  FROM (
    SELECT
      (item.ordinality - 1)::int AS line_index,
      nullif(trim(coalesce(item.value->>'sku', '')), '') AS sku,
      nullif(coalesce(item.value->>'name', item.value->>'title', item.value->>'description', ''), '') AS name,
      nullif(coalesce(item.value->>'imageUrl', item.value->>'image_url', item.value->>'thumbnailUrl', item.value->>'thumbnail', ''), '') AS image_url,
      CASE
        WHEN coalesce(item.value->>'quantity', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN greatest(0, (item.value->>'quantity')::numeric)
        ELSE 1
      END AS quantity,
      CASE
        WHEN coalesce(item.value->>'unitPrice', item.value->>'unit_price', item.value->>'price', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN coalesce(item.value->>'unitPrice', item.value->>'unit_price', item.value->>'price')::numeric
        ELSE 0
      END AS unit_price,
      CASE
        WHEN coalesce(item.value->>'lineTotal', item.value->>'line_total', item.value->>'total', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN coalesce(item.value->>'lineTotal', item.value->>'line_total', item.value->>'total')::numeric
        ELSE NULL
      END AS explicit_line_total,
      lower(coalesce(item.value->>'adjustment', 'false')) AS adjustment_text
    FROM jsonb_array_elements(coalesce(NEW.items, '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
  ) normalized
  WHERE normalized.sku IS NOT NULL
    AND normalized.quantity > 0
    AND normalized.adjustment_text NOT IN ('true', 't', '1', 'yes');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prepship_order_items_refresh ON orders;

CREATE TRIGGER prepship_order_items_refresh
AFTER INSERT OR UPDATE OF items, client_id, store_id, order_status, order_date ON orders
FOR EACH ROW
EXECUTE FUNCTION prepship_refresh_order_items_for_order();

WITH repaired AS (
  UPDATE order_items oi
  SET
    client_id = o.client_id,
    store_id = o.store_id,
    order_status = o.order_status,
    order_date = o.order_date,
    updated_at = now()
  FROM orders o
  WHERE o.id = oi.order_id
    AND (
      oi.client_id IS DISTINCT FROM o.client_id
      OR oi.store_id IS DISTINCT FROM o.store_id
      OR oi.order_status IS DISTINCT FROM o.order_status
      OR oi.order_date IS DISTINCT FROM o.order_date
    )
  RETURNING oi.id
)
SELECT count(*) FROM repaired;
