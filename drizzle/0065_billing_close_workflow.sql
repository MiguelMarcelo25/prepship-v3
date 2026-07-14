-- Audit 3.6 / B-2: activate finalized billing with immutable close records
-- and append-only credit notes. This migration never updates order or shipment
-- data and never permits finalized billing_line_items to be rewritten.

CREATE TABLE IF NOT EXISTS billing_finalizations (
  id text PRIMARY KEY,
  client_id integer NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  line_count integer NOT NULL CHECK (line_count > 0),
  order_count integer NOT NULL CHECK (order_count >= 0),
  subtotal numeric(12,2) NOT NULL CHECK (subtotal >= 0),
  finalized_by text NOT NULL,
  finalized_by_email text,
  finalized_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_finalizations_period_check CHECK (period_start < period_end),
  CONSTRAINT billing_finalizations_client_period_unq
    UNIQUE (client_id, period_start, period_end),
  CONSTRAINT billing_finalizations_id_client_unq UNIQUE (id, client_id)
);

CREATE TABLE IF NOT EXISTS billing_credit_notes (
  id text PRIMARY KEY,
  finalization_id text NOT NULL,
  client_id integer NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL,
  created_by text NOT NULL,
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_credit_notes_finalization_client_fk
    FOREIGN KEY (finalization_id, client_id)
    REFERENCES billing_finalizations(id, client_id) ON DELETE RESTRICT,
  CONSTRAINT billing_credit_notes_idempotency_unq UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS billing_credit_notes_finalization_idx
  ON billing_credit_notes (finalization_id, created_at);

ALTER TABLE billing_finalizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_notes ENABLE ROW LEVEL SECURITY;

-- Serialize period closes per client and reject overlapping close records.
-- The same advisory key is acquired by the service before it reads line items
-- and by the line-item trigger below before any write.
CREATE OR REPLACE FUNCTION billing_finalizations_block_overlap()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(36421, NEW.client_id);
  IF EXISTS (
    SELECT 1
    FROM billing_finalizations existing
    WHERE existing.client_id = NEW.client_id
      AND tstzrange(existing.period_start, existing.period_end, '[)') &&
          tstzrange(NEW.period_start, NEW.period_end, '[)')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_PERIOD_FINALIZED: billing period overlaps an existing finalization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_finalizations_overlap_guard'
      AND tgrelid = 'billing_finalizations'::regclass
  ) THEN
    CREATE TRIGGER billing_finalizations_overlap_guard
      BEFORE INSERT ON billing_finalizations
      FOR EACH ROW EXECUTE FUNCTION billing_finalizations_block_overlap();
  END IF;
END;
$$;

-- Serialize credits on their frozen finalization and enforce the remaining
-- balance in the database too. The service performs the same check for a
-- useful API error; this trigger protects scripts and concurrent writers.
CREATE OR REPLACE FUNCTION billing_credit_notes_block_excess()
RETURNS trigger AS $$
DECLARE
  frozen_subtotal numeric(12,2);
  credited_total numeric(12,2);
BEGIN
  SELECT subtotal
  INTO frozen_subtotal
  FROM billing_finalizations
  WHERE id = NEW.finalization_id
    AND client_id = NEW.client_id
  FOR UPDATE;

  IF FOUND THEN
    SELECT coalesce(sum(amount), 0)
    INTO credited_total
    FROM billing_credit_notes
    WHERE finalization_id = NEW.finalization_id
      AND client_id = NEW.client_id;

    IF credited_total + NEW.amount > frozen_subtotal THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'BILLING_CREDIT_EXCEEDS_BALANCE: credit exceeds frozen invoice balance';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_credit_notes_balance_guard'
      AND tgrelid = 'billing_credit_notes'::regclass
  ) THEN
    CREATE TRIGGER billing_credit_notes_balance_guard
      BEFORE INSERT ON billing_credit_notes
      FOR EACH ROW EXECUTE FUNCTION billing_credit_notes_block_excess();
  END IF;
END;
$$;

-- Once a close record commits, no normal insert/update/delete may change a
-- line inside that client/period. This is the DB backstop for routes, scripts,
-- regeneration, and races. Pure finalization runs before inserting the close
-- record in the same transaction, so it remains allowed.
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
      AND OLD.ship_date >= closed.period_start
      AND OLD.ship_date < closed.period_end
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_PERIOD_FINALIZED: closed billing period cannot be modified';
  END IF;

  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1
    FROM billing_finalizations closed
    WHERE closed.client_id = NEW.client_id
      AND NEW.ship_date >= closed.period_start
      AND NEW.ship_date < closed.period_end
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_PERIOD_FINALIZED: closed billing period cannot be modified';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_line_items_closed_period_guard'
      AND tgrelid = 'billing_line_items'::regclass
  ) THEN
    CREATE TRIGGER billing_line_items_closed_period_guard
      BEFORE INSERT OR UPDATE OR DELETE ON billing_line_items
      FOR EACH ROW EXECUTE FUNCTION billing_line_items_block_closed_period_mutation();
  END IF;
END;
$$;

-- Close records and credit notes are append-only business facts. Corrections
-- are another credit note, never an UPDATE or DELETE of history.
CREATE OR REPLACE FUNCTION billing_close_records_block_mutations()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'BILLING_CLOSE_IMMUTABLE: billing close records are append-only';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_finalizations_no_update_delete'
      AND tgrelid = 'billing_finalizations'::regclass
  ) THEN
    CREATE TRIGGER billing_finalizations_no_update_delete
      BEFORE UPDATE OR DELETE ON billing_finalizations
      FOR EACH ROW EXECUTE FUNCTION billing_close_records_block_mutations();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_credit_notes_no_update_delete'
      AND tgrelid = 'billing_credit_notes'::regclass
  ) THEN
    CREATE TRIGGER billing_credit_notes_no_update_delete
      BEFORE UPDATE OR DELETE ON billing_credit_notes
      FOR EACH ROW EXECUTE FUNCTION billing_close_records_block_mutations();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_finalizations_no_truncate'
      AND tgrelid = 'billing_finalizations'::regclass
  ) THEN
    CREATE TRIGGER billing_finalizations_no_truncate
      BEFORE TRUNCATE ON billing_finalizations
      FOR EACH STATEMENT EXECUTE FUNCTION billing_close_records_block_mutations();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_credit_notes_no_truncate'
      AND tgrelid = 'billing_credit_notes'::regclass
  ) THEN
    CREATE TRIGGER billing_credit_notes_no_truncate
      BEFORE TRUNCATE ON billing_credit_notes
      FOR EACH STATEMENT EXECUTE FUNCTION billing_close_records_block_mutations();
  END IF;
END;
$$;
