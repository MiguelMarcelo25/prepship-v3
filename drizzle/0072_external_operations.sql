-- PS-423: one durable provider-operation authority for label purchase,
-- Shopify Shipping, returns, voids, and marketplace confirmations.
-- Additive only: no historical order/shipment/label row is changed.

CREATE TABLE IF NOT EXISTS external_operations (
  id serial PRIMARY KEY,
  operation_key text NOT NULL,
  kind text NOT NULL,
  provider text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  semantic_generation integer NOT NULL DEFAULT 1,
  request_hash text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'prepared',
  generation integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  provider_operation_id text,
  provider_result_id text,
  provider_receipt jsonb,
  local_result jsonb,
  last_error text,
  resolution_note text,
  resolved_by text,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  receipt_recorded_at timestamptz,
  consumed_at timestamptz,
  cancellation_requested_at timestamptz,
  cancellation_acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_operations_semantic_generation_chk CHECK (semantic_generation > 0),
  CONSTRAINT external_operations_generation_chk CHECK (generation >= 0),
  CONSTRAINT external_operations_state_chk CHECK (
    state IN (
      'prepared',
      'in_flight',
      'receipt_recorded',
      'consumed',
      'failed_pre_dispatch',
      'reconcile_required'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS external_operations_key_unq
  ON external_operations (operation_key);
CREATE UNIQUE INDEX IF NOT EXISTS external_operations_idempotency_unq
  ON external_operations (idempotency_key);
CREATE INDEX IF NOT EXISTS external_operations_state_lease_idx
  ON external_operations (state, lease_expires_at);
CREATE INDEX IF NOT EXISTS external_operations_subject_idx
  ON external_operations (subject_type, subject_id, kind);

ALTER TABLE external_operations ENABLE ROW LEVEL SECURITY;
