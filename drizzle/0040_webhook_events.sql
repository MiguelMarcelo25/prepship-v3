-- PS-128 + PS-129: durable, redacted inbound webhook/event ledger.
-- Per user override unlock shipped data on 2026-06-09: new ledger table only; reads
-- shipped/cancelled SIGNALS for the pre-label safety guard. No raw payloads / PII / tokens
-- are stored (payload_hash + redacted metadata only). Does NOT alter orders/shipments.
-- Idempotent so it is safe to re-apply and matches the runtime ensure in
-- src/services/fulfillment/webhook-ledger.ts.

CREATE TABLE IF NOT EXISTS webhook_events (
  id serial PRIMARY KEY,
  provider text NOT NULL,
  event_type text NOT NULL,
  canonical_status text,
  external_event_id text,
  payload_hash text NOT NULL,
  dedupe_key text NOT NULL,
  source_order_number text,
  source_order_id text,
  related_order_id integer,
  related_shipment_id integer,
  status text NOT NULL DEFAULT 'received',
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_dedupe_idx ON webhook_events (dedupe_key);
CREATE INDEX IF NOT EXISTS webhook_events_order_status_idx ON webhook_events (related_order_id, canonical_status);
CREATE INDEX IF NOT EXISTS webhook_events_source_lookup_idx ON webhook_events (provider, source_order_number);
CREATE INDEX IF NOT EXISTS webhook_events_source_id_idx ON webhook_events (source_order_id);

-- RLS posture matches the project model (backend = postgres owner bypasses RLS; no frontend
-- direct access). Enable RLS with no policy so any non-owner role is denied by default.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
