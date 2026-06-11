-- PS-120 — per-order backend rate-job status (pending / rating).
-- Additive only: a tiny side table that records "what is the backend backfill doing about
-- this order's rate RIGHT NOW?" keyed by order id + a request fingerprint. It NEVER stores
-- money/proof/selected-rate data (that stays on order_overrides.best_rate_json /
-- shipments.selected_rate_json) — only a transient state string + the fingerprint it pins.
--
-- The producer (worker rates-backfill) writes 'pending' on enqueue and 'rating' on pickup,
-- and clears the row when the rate resolves. The reader (API /orders) only OVERRIDES the
-- displayed bestRateState when the stored fingerprint == the order's CURRENT fingerprint AND
-- there is no fresh displayable saved rate — so when no row exists or the fingerprint is
-- stale, the orders payload is byte-identical to before. Does NOT alter orders/shipments.
--
-- Idempotent (CREATE ... IF NOT EXISTS) so it is safe to re-apply and matches the runtime
-- ensure expectation in src/services/shipping-workflow/order-rate-job-status.ts.

CREATE TABLE IF NOT EXISTS order_rate_jobs (
  order_id integer PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  state text NOT NULL,
  request_fingerprint text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_rate_jobs_updated_idx ON order_rate_jobs (updated_at DESC);

-- RLS posture matches the project model (backend = postgres owner bypasses RLS; no frontend
-- direct access). Enable RLS with no policy so any non-owner role is denied by default.
ALTER TABLE order_rate_jobs ENABLE ROW LEVEL SECURITY;
