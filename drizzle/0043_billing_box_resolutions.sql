-- PS-207 — Bill the box the shipment actually used; persistent operator review resolutions.
--
-- One row per order: an EXPLICIT operator directive ("bill this order as box X
-- and/or at price Y"). The billing generator consults this table FIRST, before
-- any shipment evidence (selected package / dims). Range regeneration deletes
-- and recreates billing_line_items only — it must NEVER touch this table; that
-- persistence is the point (pre-PS-207, manual box-line edits were wiped by
-- every regenerate).
--
-- override_price is the FINAL package_cost line amount (markup is NOT applied)
-- so a regenerate reproduces exactly what the operator set in the Edit Billing
-- Detail modal.
--
-- Additive only — no orders/shipments/billing_line_items changes. Idempotent
-- (IF NOT EXISTS) and matched by the runtime ensure in src/services/billing.ts.

CREATE TABLE IF NOT EXISTS billing_box_resolutions (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shipment_id integer REFERENCES shipments(id),
  package_id integer REFERENCES packages(id),
  override_price numeric(10, 2),
  note text,
  resolved_by text,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_box_resolutions_order_unq UNIQUE (order_id)
);

-- RLS posture matches the project model (backend = postgres owner bypasses
-- RLS; no frontend direct access). Enable RLS with no policy so any non-owner
-- role is denied by default.
ALTER TABLE billing_box_resolutions ENABLE ROW LEVEL SECURITY;
