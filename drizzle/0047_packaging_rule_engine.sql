-- PS-223 — packaging rule engine storage.
--
-- Two per-client tables that hold DJ's SKU classification + packing rules, plus a
-- provenance column on the existing combo-defaults table so the engine never
-- overwrites an operator-set default.
--
--   client_sku_classes   — SKU -> packaging class.
--   client_packing_rules — class-count signature (rule_key) -> catalog package.
--   client_combo_package_defaults.source — 'operator' | 'rule_engine' | 'import'.
--
-- Additive only. Idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) and matched
-- by the runtime ensure in src/services/packaging-rules.ts (ensurePackagingRulesSchema).
-- No rows are seeded here — the 53-SKU classification + rules 1–9 are DJ's data.

CREATE TABLE IF NOT EXISTS client_sku_classes (
  id serial PRIMARY KEY,
  client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sku text NOT NULL,
  class_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS client_sku_classes_client_sku_idx ON client_sku_classes (client_id, sku);
CREATE INDEX IF NOT EXISTS client_sku_classes_client_idx ON client_sku_classes (client_id);

CREATE TABLE IF NOT EXISTS client_packing_rules (
  id serial PRIMARY KEY,
  client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  rule_key text NOT NULL,
  package_id integer REFERENCES packages(id),
  package_code text,
  priority integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'rule_engine',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS client_packing_rules_client_key_idx ON client_packing_rules (client_id, rule_key);
CREATE INDEX IF NOT EXISTS client_packing_rules_client_idx ON client_packing_rules (client_id);

-- Provenance on the existing combo-defaults table. Default 'operator' so every
-- pre-existing row is treated as operator-owned (the engine will not overwrite it).
ALTER TABLE client_combo_package_defaults ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'operator';

-- RLS posture matches the project model (backend = postgres owner bypasses RLS;
-- no frontend direct access). Enable RLS with no policy → non-owner denied.
ALTER TABLE client_sku_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_packing_rules ENABLE ROW LEVEL SECURITY;
