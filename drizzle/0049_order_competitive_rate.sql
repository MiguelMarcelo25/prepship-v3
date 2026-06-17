-- PS-220 — SHIPP house-account margin: sidecar table for the captured "next-best non-SHIPP rate".
-- LOCKDOWN-SAFE: a NEW table only. No ALTER/UPDATE/DELETE against the locked orders/shipments
-- tables anywhere. drp_cost/margin are INTERNAL (redacted from any client-facing serializer);
-- customer_rate is the billed + portal value. Forward-only — capture starts at deploy.
CREATE TABLE IF NOT EXISTS order_competitive_rate (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shipment_id integer REFERENCES shipments(id),
  client_id integer,
  drp_cost numeric(10,2) NOT NULL,            -- SHIPP rate DRP actually pays (INTERNAL)
  customer_rate numeric(10,2) NOT NULL,       -- cheapest eligible non-SHIPP (billed + portal)
  margin numeric(10,2) NOT NULL CHECK (margin >= 0),  -- customer_rate - drp_cost; negative is impossible by model
  source text,                                -- 'projected' (awaiting save) | 'realized' (label purchase)
  source_carrier text,
  source_service text,
  source_provider_account_id integer,
  competitor_count integer NOT NULL DEFAULT 0,  -- eligible non-SHIPP seen; 0 ⇒ pass-through (customer_rate = drp_cost)
  is_house_order boolean NOT NULL DEFAULT false,
  quote_fingerprint text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_competitive_rate_order_idx ON order_competitive_rate (order_id);
CREATE INDEX IF NOT EXISTS order_competitive_rate_house_idx ON order_competitive_rate (is_house_order);
-- Realized rows (a purchased label) are idempotent per (order, shipment); projected rows (no label
-- yet) dedupe per order. Partial uniques avoid the NULL-shipment-id "all NULLs are distinct" trap.
CREATE UNIQUE INDEX IF NOT EXISTS order_competitive_rate_realized_unq
  ON order_competitive_rate (order_id, shipment_id) WHERE shipment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_competitive_rate_projected_unq
  ON order_competitive_rate (order_id) WHERE shipment_id IS NULL;
ALTER TABLE order_competitive_rate ENABLE ROW LEVEL SECURITY;
