-- PS-434: forward-only California weekend billing roll-forward.
--
-- Additive only. There is deliberately no UPDATE/backfill: existing line rows
-- retain their exact ship_date, totals, and legacy range meaning through
-- coalesce(billing_effective_date, ship_date). Activation is controlled by the
-- default-off BILLING_WEEKEND_ROLLFORWARD_EFFECTIVE_DATE runtime setting.

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS billing_effective_date timestamptz,
  ADD COLUMN IF NOT EXISTS billing_policy_version text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_line_items_policy_version_check'
      AND conrelid = 'billing_line_items'::regclass
  ) THEN
    ALTER TABLE billing_line_items
      ADD CONSTRAINT billing_line_items_policy_version_check
      CHECK (
        billing_policy_version IS NULL OR billing_policy_version IN (
          'legacy_calendar_v1',
          'weekday_weekend_rollforward_v2'
        )
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS billing_li_effective_date_idx
  ON billing_line_items (coalesce(billing_effective_date, ship_date));

-- Finalized periods are defined by the customer-facing effective day. Legacy
-- rows remain byte/cent compatible because their nullable effective day falls
-- back to ship_date. This replaces only the existing DB guard function; the
-- trigger identity and fail-closed behavior are unchanged.
CREATE OR REPLACE FUNCTION billing_line_items_block_closed_period_mutation()
RETURNS trigger AS $$
DECLARE
  lock_client_id integer;
BEGIN
  FOR lock_client_id IN
    SELECT DISTINCT candidate
    FROM unnest(ARRAY[
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.client_id END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.client_id END
    ]) AS ids(candidate)
    WHERE candidate IS NOT NULL
    ORDER BY candidate
  LOOP
    PERFORM pg_advisory_xact_lock(36421, lock_client_id);
  END LOOP;

  IF TG_OP <> 'INSERT' AND EXISTS (
    SELECT 1
    FROM billing_finalizations closed
    WHERE closed.client_id = OLD.client_id
      AND coalesce(OLD.billing_effective_date, OLD.ship_date) >= closed.period_start
      AND coalesce(OLD.billing_effective_date, OLD.ship_date) < closed.period_end
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_PERIOD_FINALIZED: closed billing period cannot be modified';
  END IF;

  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1
    FROM billing_finalizations closed
    WHERE closed.client_id = NEW.client_id
      AND coalesce(NEW.billing_effective_date, NEW.ship_date) >= closed.period_start
      AND coalesce(NEW.billing_effective_date, NEW.ship_date) < closed.period_end
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_PERIOD_FINALIZED: closed billing period cannot be modified';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
