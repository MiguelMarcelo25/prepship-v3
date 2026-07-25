-- PS-466: recoverable leases for automation outbox and action effects.
-- This migration is additive and never updates orders, shipments, or provider data.

ALTER TABLE automation_action_results
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS automation_action_results_reclaim_idx
  ON automation_action_results (status, lease_expires_at, id)
  WHERE status IN ('planned', 'failed');

ALTER TABLE automation_outbox
  ADD COLUMN IF NOT EXISTS lock_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS automation_outbox_reclaim_idx
  ON automation_outbox (status, available_at, lease_expires_at, id)
  WHERE status IN ('pending', 'failed', 'processing');
