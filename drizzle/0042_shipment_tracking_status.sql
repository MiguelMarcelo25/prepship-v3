-- Tracking-driven print-queue retirement — carrier tracking state per (order, tracking number).
--
-- Per user override unlock shipped data on 2026-06-11: additive only — this migration does NOT
-- alter orders/shipments. Tracking state lives in this side table because the shipments table is
-- under the shipped-data lockdown; the poller (src/services/shipment-tracking.ts) only READS
-- shipments and writes here. Redacted by design: normalized status + truncated carrier status
-- line + dates — never the carrier's events[] checkpoints or raw payloads.
--
-- Also adds print_queue_orders.auto_retired_at: stamped when a 'queued' entry is moved to the
-- new 'delivered' status (package reached the customer — its label never needs printing). The
-- entry leaves the ACTIVE queue (which filters status='queued') but stays in History.
--
-- Idempotent (IF NOT EXISTS) so it is safe to re-apply and matches the runtime ensure in
-- src/services/shipment-tracking.ts.

CREATE TABLE IF NOT EXISTS shipment_tracking_status (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  client_id integer,
  tracking_number text NOT NULL,
  carrier_code text,
  status text NOT NULL DEFAULT 'unknown',
  status_description text,
  delivered_at timestamptz,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  check_count integer NOT NULL DEFAULT 0,
  last_error text,
  source text NOT NULL DEFAULT 'shipstation_v2',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_tracking_status_order_tracking_unq UNIQUE (order_id, tracking_number)
);

CREATE INDEX IF NOT EXISTS shipment_tracking_status_order_idx ON shipment_tracking_status (order_id);
CREATE INDEX IF NOT EXISTS shipment_tracking_status_poll_idx ON shipment_tracking_status (status, last_checked_at);

-- RLS posture matches the project model (backend = postgres owner bypasses RLS; no frontend
-- direct access). Enable RLS with no policy so any non-owner role is denied by default.
ALTER TABLE shipment_tracking_status ENABLE ROW LEVEL SECURITY;

ALTER TABLE print_queue_orders ADD COLUMN IF NOT EXISTS auto_retired_at timestamptz;
