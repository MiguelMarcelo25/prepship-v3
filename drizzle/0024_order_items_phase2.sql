CREATE TABLE IF NOT EXISTS "order_items" (
  "id" serial PRIMARY KEY,
  "order_id" integer NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "line_index" integer NOT NULL DEFAULT 0,
  "sku" text NOT NULL,
  "name" text,
  "quantity" numeric(12, 3) NOT NULL DEFAULT 0,
  "unit_price" numeric(12, 2) NOT NULL DEFAULT 0,
  "line_total" numeric(12, 2) NOT NULL DEFAULT 0,
  "image_url" text,
  "client_id" integer REFERENCES "clients"("id"),
  "store_id" integer,
  "order_status" text NOT NULL,
  "order_date" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "order_items_order_line_idx"
  ON "order_items" ("order_id", "line_index");
CREATE INDEX IF NOT EXISTS "order_items_order_id_idx"
  ON "order_items" ("order_id");
CREATE INDEX IF NOT EXISTS "order_items_sku_idx"
  ON "order_items" ("sku");
CREATE INDEX IF NOT EXISTS "order_items_lower_sku_idx"
  ON "order_items" (lower("sku"));
CREATE INDEX IF NOT EXISTS "order_items_date_idx"
  ON "order_items" ("order_date");
CREATE INDEX IF NOT EXISTS "order_items_client_date_idx"
  ON "order_items" ("client_id", "order_date");
CREATE INDEX IF NOT EXISTS "order_items_store_date_idx"
  ON "order_items" ("store_id", "order_date");
CREATE INDEX IF NOT EXISTS "order_items_active_date_idx"
  ON "order_items" ("order_date")
  WHERE "order_status" <> 'cancelled';
CREATE INDEX IF NOT EXISTS "order_items_active_client_date_idx"
  ON "order_items" ("client_id", "order_date")
  WHERE "order_status" <> 'cancelled';
CREATE INDEX IF NOT EXISTS "order_items_active_sku_date_idx"
  ON "order_items" ("sku", "order_date")
  WHERE "order_status" <> 'cancelled';

WITH source_orders AS (
  SELECT *
  FROM "orders"
  WHERE jsonb_array_length(coalesce("items", '[]'::jsonb)) > 0
),
raw_items AS (
  SELECT
    o."id" AS order_id,
    (item.ordinality - 1)::int AS line_index,
    nullif(trim(coalesce(item.value->>'sku', '')), '') AS sku,
    nullif(coalesce(item.value->>'name', item.value->>'title', item.value->>'description', ''), '') AS name,
    nullif(coalesce(item.value->>'imageUrl', item.value->>'image_url', item.value->>'thumbnailUrl', item.value->>'thumbnail', ''), '') AS image_url,
    coalesce(item.value->>'quantity', '') AS qty_text,
    coalesce(item.value->>'unitPrice', item.value->>'unit_price', item.value->>'price', '') AS unit_price_text,
    coalesce(item.value->>'lineTotal', item.value->>'line_total', item.value->>'total', '') AS line_total_text,
    o."client_id",
    o."store_id",
    o."order_status",
    o."order_date",
    lower(coalesce(item.value->>'adjustment', 'false')) AS adjustment_text
  FROM source_orders o
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(o."items", '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
),
normalized AS (
  SELECT
    order_id,
    line_index,
    sku,
    name,
    image_url,
    CASE
      WHEN qty_text ~ '^-?[0-9]+([.][0-9]+)?$' THEN greatest(0, qty_text::numeric)
      ELSE 1
    END AS quantity,
    CASE
      WHEN unit_price_text ~ '^-?[0-9]+([.][0-9]+)?$' THEN unit_price_text::numeric
      ELSE 0
    END AS unit_price,
    CASE
      WHEN line_total_text ~ '^-?[0-9]+([.][0-9]+)?$' THEN line_total_text::numeric
      ELSE NULL
    END AS explicit_line_total,
    client_id,
    store_id,
    order_status,
    order_date,
    adjustment_text
  FROM raw_items
  WHERE sku IS NOT NULL
    AND adjustment_text NOT IN ('true', 't', '1', 'yes')
)
INSERT INTO "order_items" (
  "order_id",
  "line_index",
  "sku",
  "name",
  "quantity",
  "unit_price",
  "line_total",
  "image_url",
  "client_id",
  "store_id",
  "order_status",
  "order_date",
  "updated_at"
)
SELECT
  order_id,
  line_index,
  sku,
  name,
  quantity,
  unit_price,
  coalesce(explicit_line_total, unit_price * quantity),
  image_url,
  client_id,
  store_id,
  order_status,
  order_date,
  now()
FROM normalized
WHERE quantity > 0
ON CONFLICT ("order_id", "line_index") DO UPDATE SET
  "sku" = excluded."sku",
  "name" = excluded."name",
  "quantity" = excluded."quantity",
  "unit_price" = excluded."unit_price",
  "line_total" = excluded."line_total",
  "image_url" = excluded."image_url",
  "client_id" = excluded."client_id",
  "store_id" = excluded."store_id",
  "order_status" = excluded."order_status",
  "order_date" = excluded."order_date",
  "updated_at" = now();

CREATE TABLE IF NOT EXISTS "analytics_cache" (
  "cache_key" text PRIMARY KEY,
  "payload" jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "analytics_cache_expires_idx"
  ON "analytics_cache" ("expires_at");
