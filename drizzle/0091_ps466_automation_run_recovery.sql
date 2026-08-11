-- PS-466 recovery closeout: add fenced leases and durable recovery audit to automation runs.
-- Additive only: no order, shipment, provider, billing, inventory, or historical-row DML.

ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_count integer NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
  ADD COLUMN IF NOT EXISTS last_recovery_code text,
  ADD COLUMN IF NOT EXISTS last_recovered_at timestamptz;

-- The hot-table recovery index is created CONCURRENTLY by
-- scripts/apply-ps-466-run-recovery-migration.ts, outside a transaction.
