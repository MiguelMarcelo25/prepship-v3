-- PS-449: signed post-finalization corrections are append-only business facts
-- projected into the current billing period. This migration is additive only:
-- it does not backfill, update, or delete historical billing, order, or
-- shipment rows.

ALTER TABLE billing_credit_notes
  ADD COLUMN IF NOT EXISTS adjustment_kind text NOT NULL DEFAULT 'credit',
  ADD COLUMN IF NOT EXISTS adjustment_source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_order_id integer REFERENCES orders(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS posting_version text NOT NULL DEFAULT 'legacy_credit_v1',
  ADD COLUMN IF NOT EXISTS effective_date timestamptz,
  ADD COLUMN IF NOT EXISTS billing_policy_version text;

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS source_finalization_id text,
  ADD COLUMN IF NOT EXISTS billing_adjustment_id text;

ALTER TABLE billing_summary_metrics
  ADD COLUMN IF NOT EXISTS adjustment_total numeric(14, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_credit_notes_adjustment_kind_chk'
      AND conrelid = 'billing_credit_notes'::regclass
  ) THEN
    ALTER TABLE billing_credit_notes
      ADD CONSTRAINT billing_credit_notes_adjustment_kind_chk
      CHECK (adjustment_kind IN ('credit', 'debit'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_credit_notes_adjustment_source_chk'
      AND conrelid = 'billing_credit_notes'::regclass
  ) THEN
    ALTER TABLE billing_credit_notes
      ADD CONSTRAINT billing_credit_notes_adjustment_source_chk
      CHECK (adjustment_source IN ('manual', 'regeneration'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_credit_notes_posting_version_chk'
      AND conrelid = 'billing_credit_notes'::regclass
  ) THEN
    ALTER TABLE billing_credit_notes
      ADD CONSTRAINT billing_credit_notes_posting_version_chk
      CHECK (posting_version IN ('legacy_credit_v1', 'current_period_v2'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_credit_notes_current_period_fields_chk'
      AND conrelid = 'billing_credit_notes'::regclass
  ) THEN
    ALTER TABLE billing_credit_notes
      ADD CONSTRAINT billing_credit_notes_current_period_fields_chk
      CHECK (
        posting_version = 'legacy_credit_v1'
        OR (
          effective_date IS NOT NULL
          AND billing_policy_version IN (
            'legacy_calendar_v1',
            'weekday_weekend_rollforward_v2'
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_credit_notes_id_client_unq'
      AND conrelid = 'billing_credit_notes'::regclass
  ) THEN
    ALTER TABLE billing_credit_notes
      ADD CONSTRAINT billing_credit_notes_id_client_unq UNIQUE (id, client_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_credit_notes_finalization_client_fk'
      AND conrelid = 'billing_credit_notes'::regclass
  ) THEN
    ALTER TABLE billing_credit_notes
      ADD CONSTRAINT billing_credit_notes_finalization_client_fk
      FOREIGN KEY (finalization_id, client_id)
      REFERENCES billing_finalizations(id, client_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_line_items_adjustment_reference_chk'
      AND conrelid = 'billing_line_items'::regclass
  ) THEN
    ALTER TABLE billing_line_items
      ADD CONSTRAINT billing_line_items_adjustment_reference_chk
      CHECK (
        (
          line_type <> 'billing_adjustment'
          AND billing_adjustment_id IS NULL
          AND source_finalization_id IS NULL
        ) OR (
          line_type = 'billing_adjustment'
          AND billing_adjustment_id IS NOT NULL
          AND source_finalization_id IS NOT NULL
          AND order_id IS NULL
          AND shipment_id IS NULL
          AND ship_date IS NOT NULL
          AND billing_effective_date IS NOT NULL
          AND billing_policy_version IS NOT NULL
          AND qty = 1
          AND unit_cost = total_cost
          AND total_cost <> 0
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_line_items_source_finalization_client_fk'
      AND conrelid = 'billing_line_items'::regclass
  ) THEN
    ALTER TABLE billing_line_items
      ADD CONSTRAINT billing_line_items_source_finalization_client_fk
      FOREIGN KEY (source_finalization_id, client_id)
      REFERENCES billing_finalizations(id, client_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_line_items_adjustment_client_fk'
      AND conrelid = 'billing_line_items'::regclass
  ) THEN
    ALTER TABLE billing_line_items
      ADD CONSTRAINT billing_line_items_adjustment_client_fk
      FOREIGN KEY (billing_adjustment_id, client_id)
      REFERENCES billing_credit_notes(id, client_id) ON DELETE RESTRICT;
  END IF;
END
$$;

-- A current-period v2 note and its visible billing-line projection must commit
-- together. The deferred trigger lets the policy insert the note first so the
-- line's foreign key can reference it, then verifies the one-to-one projection
-- at transaction commit. Legacy credit rows remain valid without a backfill.
CREATE OR REPLACE FUNCTION billing_credit_notes_require_projection()
RETURNS trigger AS $$
DECLARE
  projection_count integer;
BEGIN
  IF NEW.posting_version <> 'current_period_v2' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_ADJUSTMENT_LEGACY_WRITE_DISABLED: new corrections require current-period posting';
  END IF;

  SELECT count(*)::int
  INTO projection_count
    FROM billing_line_items projected
    WHERE projected.billing_adjustment_id = NEW.id
      AND projected.source_finalization_id = NEW.finalization_id
      AND projected.client_id = NEW.client_id
      AND projected.line_type = 'billing_adjustment'
      AND projected.total_cost = CASE
        WHEN NEW.adjustment_kind = 'credit' THEN -NEW.amount
        ELSE NEW.amount
      END
      AND projected.billing_effective_date = NEW.effective_date
      AND projected.billing_policy_version = NEW.billing_policy_version;

  IF projection_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_ADJUSTMENT_PROJECTION_MISSING: signed current-period projection is required';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_credit_notes_projection_guard'
      AND tgrelid = 'billing_credit_notes'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER billing_credit_notes_projection_guard
      AFTER INSERT ON billing_credit_notes
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION billing_credit_notes_require_projection();
  END IF;
END
$$;

-- A signed credit can make the current period a net refund. Such a period must
-- still be finalizable and immutable, so remove the legacy non-negative-only
-- close constraint. The frozen subtotal remains exact and signed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_finalizations_subtotal_check'
      AND conrelid = 'billing_finalizations'::regclass
  ) THEN
    ALTER TABLE billing_finalizations
      DROP CONSTRAINT billing_finalizations_subtotal_check;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS billing_li_adjustment_unq
  ON billing_line_items (billing_adjustment_id)
  WHERE billing_adjustment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_li_source_finalization_idx
  ON billing_line_items (source_finalization_id);

CREATE INDEX IF NOT EXISTS billing_credit_notes_source_order_idx
  ON billing_credit_notes (finalization_id, source_order_id, created_at)
  WHERE source_order_id IS NOT NULL;

-- Balance enforcement now uses the signed net of all corrections. A credit is
-- negative and a debit is positive. This permits an explicit debit path while
-- retaining the rule that net credits cannot drive an invoice below zero.
CREATE OR REPLACE FUNCTION billing_credit_notes_block_excess()
RETURNS trigger AS $$
DECLARE
  frozen_subtotal numeric(12,2);
  signed_adjustment_total numeric(12,2);
  new_signed_amount numeric(12,2);
BEGIN
  PERFORM pg_advisory_xact_lock(36421, NEW.client_id);

  SELECT subtotal
  INTO frozen_subtotal
  FROM billing_finalizations
  WHERE id = NEW.finalization_id
    AND client_id = NEW.client_id
  FOR UPDATE;

  IF FOUND THEN
    SELECT coalesce(sum(
      CASE WHEN adjustment_kind = 'credit' THEN -amount ELSE amount END
    ), 0)
    INTO signed_adjustment_total
    FROM billing_credit_notes
    WHERE finalization_id = NEW.finalization_id
      AND client_id = NEW.client_id;

    new_signed_amount := CASE
      WHEN NEW.adjustment_kind = 'credit' THEN -NEW.amount
      ELSE NEW.amount
    END;

    IF frozen_subtotal + signed_adjustment_total + new_signed_amount < 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'BILLING_CREDIT_EXCEEDS_BALANCE: credit exceeds adjusted invoice balance';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Current-period adjustment projections are immutable too. Corrections to a
-- correction are another signed adjustment, never an UPDATE or DELETE. The
-- only allowed update is the close workflow's exact false -> true invoiced
-- transition; every other column must remain byte-identical.
CREATE OR REPLACE FUNCTION billing_line_items_block_adjustment_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.billing_adjustment_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_ADJUSTMENT_IMMUTABLE: billing adjustments are append-only';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.billing_adjustment_id IS NOT NULL OR NEW.billing_adjustment_id IS NOT NULL
  ) THEN
    IF NOT (
      OLD.billing_adjustment_id IS NOT NULL
      AND OLD.invoiced = false
      AND NEW.invoiced = true
      AND (to_jsonb(OLD) - 'invoiced') = (to_jsonb(NEW) - 'invoiced')
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'BILLING_ADJUSTMENT_IMMUTABLE: billing adjustments are append-only';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_line_items_adjustment_immutable_guard'
      AND tgrelid = 'billing_line_items'::regclass
  ) THEN
    CREATE TRIGGER billing_line_items_adjustment_immutable_guard
      BEFORE UPDATE OR DELETE ON billing_line_items
      FOR EACH ROW EXECUTE FUNCTION billing_line_items_block_adjustment_mutation();
  END IF;
END
$$;

-- Preserve PS-434's effective-day closed-period guard and client lock.
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
