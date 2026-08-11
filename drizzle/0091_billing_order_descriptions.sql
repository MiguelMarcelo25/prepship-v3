-- PS-498 — durable per-order operator DESCRIPTION for a billing invoice-line correction.
--
-- One row per order: the operator's own sentence explaining why that order's
-- invoice line was corrected ("DHL eCommerce Parcel Direct to Gatineau, Quebec").
-- Captured per row by the Import Box Size & Shipping paste grid, and read back
-- READ-ONLY in the Edit Billing Detail modal with author + timestamp.
--
-- This is NOT a money input and NOT a box directive. The billing generator never
-- reads it; range regeneration deletes and recreates billing_line_items only and
-- must NEVER touch this table — that persistence is the point.
--
-- WHY ITS OWN TABLE, deliberately, after three cheaper hosts were rejected:
--   * billing_manual_overrides.note is keyed (order_id, line_type), so one
--     description would be stored up to three times and diverge on the next
--     single-line edit; and its CHECK excludes 'package_cost', so a box-only
--     edit would store NOTHING and lose the description silently.
--   * billing_box_resolutions.note is per-order and otherwise ideal, but
--     src/services/billing-box-cost-by-dims.ts DELETEs whole rows matched on
--     note when a dims sweep is undone — that would erase descriptions.
--   * billing_line_items.description is generator-owned and participates in
--     three unique indexes, so it cannot be widened without forking idempotency.
-- Every one of those columns is also synthesized from the edit `reason` on each
-- save. This column must NOT be: an absent field means "leave it alone".
--
-- description is NOT NULL with a non-blank CHECK: a row exists only to hold a
-- description, so "row present, description blank" is not a reachable state.
-- The CHECK is the last line of the anti-blanking defence and is verified at
-- boot via REQUIRED_CONSTRAINTS in src/services/runtime-schema-readiness.ts.
--
-- Additive only — no orders/shipments/billing_line_items changes. Idempotent.

CREATE TABLE IF NOT EXISTS billing_order_descriptions (
  order_id integer PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  description text NOT NULL,
  saved_by text,
  saved_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_order_descriptions_description_chk
    CHECK (btrim(description) <> '' AND length(description) <= 500)
);

-- RLS posture matches the project model (backend = postgres owner bypasses
-- RLS; no frontend direct access). Enable RLS with no policy so any non-owner
-- role is denied by default.
ALTER TABLE billing_order_descriptions ENABLE ROW LEVEL SECURITY;
