-- PS-466: retire the settings-backed shipping_automation_rules authority.
-- This migration imports active exclusions into typed relational controls before
-- removing the legacy settings row. It never reads or writes orders, shipments,
-- provider state, labels, postage, inventory, billing, or marketplace data.

CREATE TABLE IF NOT EXISTS automation_shipping_controls (
  id bigserial PRIMARY KEY,
  control_key text NOT NULL,
  control_type text NOT NULL CHECK (control_type IN ('carrier', 'service')),
  client_id integer REFERENCES clients(id) ON DELETE RESTRICT,
  store_id integer,
  carrier_id text,
  carrier_code text,
  service_code text,
  service_name text,
  disabled boolean NOT NULL DEFAULT true CHECK (disabled = true),
  reason text,
  system_locked boolean NOT NULL DEFAULT false,
  provenance text NOT NULL DEFAULT 'operator'
    CHECK (provenance IN ('operator', 'legacy_import', 'system')),
  source text,
  position bigint NOT NULL CHECK (position >= 0),
  source_updated_at text,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_shipping_controls_key_unq UNIQUE (control_key),
  CONSTRAINT automation_shipping_controls_scope_chk
    CHECK (client_id IS NOT NULL OR store_id IS NOT NULL),
  CONSTRAINT automation_shipping_controls_identity_chk CHECK (
    control_type = 'service' OR carrier_id IS NOT NULL OR carrier_code IS NOT NULL
  ),
  CONSTRAINT automation_shipping_controls_service_identity_chk CHECK (
    control_type <> 'service' OR service_code IS NOT NULL OR service_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS automation_shipping_controls_scope_idx
  ON automation_shipping_controls (client_id, store_id, control_type, position, id);

-- Fail closed on malformed JSON: a migration error leaves the settings row and
-- the whole transaction untouched instead of silently dropping operator policy.
WITH legacy_payload AS (
  SELECT value::jsonb AS document
  FROM settings
  WHERE key = 'shipping_automation_rules'
), legacy_entries AS (
  SELECT entry.rule, entry.ordinality::bigint AS position
  FROM legacy_payload
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE jsonb_typeof(document)
      WHEN 'array' THEN document
      WHEN 'object' THEN COALESCE(document->'rules', '[]'::jsonb)
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS entry(rule, ordinality)
), normalized AS (
  SELECT
    rule,
    position,
    rule->>'type' AS control_type,
    CASE
      WHEN NULLIF(BTRIM(rule->>'clientId'), '') ~ '^[0-9]+$'
        THEN (rule->>'clientId')::integer
      ELSE NULL
    END AS client_id,
    CASE
      WHEN NULLIF(BTRIM(rule->>'storeId'), '') ~ '^[0-9]+$'
        THEN (rule->>'storeId')::integer
      ELSE NULL
    END AS store_id,
    NULLIF(BTRIM(rule->>'carrierId'), '') AS carrier_id,
    NULLIF(BTRIM(rule->>'carrierCode'), '') AS carrier_code,
    NULLIF(BTRIM(rule->>'serviceCode'), '') AS service_code,
    NULLIF(BTRIM(rule->>'serviceName'), '') AS service_name,
    NULLIF(rule->>'reason', '') AS reason,
    COALESCE(rule->'locked' = 'true'::jsonb, false) AS system_locked,
    NULLIF(rule->>'source', '') AS source,
    NULLIF(rule->>'updatedAt', '') AS source_updated_at,
    COALESCE(NULLIF(rule->>'updatedBy', ''), 'ps-466-legacy-import') AS updated_by
  FROM legacy_entries
  WHERE rule->>'type' IN ('carrier', 'service')
    AND rule->'disabled' = 'true'::jsonb
), keyed AS (
  SELECT
    *,
    control_type || '|' ||
      COALESCE(client_id::text, '') || '|' ||
      COALESCE(store_id::text, '') || '|' ||
      LOWER(BTRIM(COALESCE(carrier_id, ''))) || '|' ||
      LOWER(BTRIM(COALESCE(carrier_code, ''))) || '|' ||
      LOWER(BTRIM(COALESCE(service_code, ''))) || '|' ||
      LOWER(BTRIM(COALESCE(service_name, ''))) AS control_key
  FROM normalized
  WHERE (client_id IS NOT NULL OR store_id IS NOT NULL)
    AND (control_type = 'service' OR carrier_id IS NOT NULL OR carrier_code IS NOT NULL)
    AND (control_type <> 'service' OR service_code IS NOT NULL OR service_name IS NOT NULL)
), deduplicated AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY control_key ORDER BY position DESC) AS duplicate_rank
  FROM keyed
)
INSERT INTO automation_shipping_controls (
  control_key,
  control_type,
  client_id,
  store_id,
  carrier_id,
  carrier_code,
  service_code,
  service_name,
  disabled,
  reason,
  system_locked,
  provenance,
  source,
  position,
  source_updated_at,
  updated_by
)
SELECT
  control_key,
  control_type,
  client_id,
  store_id,
  carrier_id,
  carrier_code,
  service_code,
  service_name,
  true,
  reason,
  system_locked,
  CASE WHEN system_locked OR source = 'system' THEN 'system' ELSE 'legacy_import' END,
  source,
  position,
  source_updated_at,
  updated_by
FROM deduplicated
WHERE duplicate_rank = 1
ON CONFLICT (control_key) DO NOTHING;

-- The insert and retirement execute in the same migration transaction. Once
-- this row is gone, runtime code has no settings-backed fallback authority.
DELETE FROM settings WHERE key = 'shipping_automation_rules';
