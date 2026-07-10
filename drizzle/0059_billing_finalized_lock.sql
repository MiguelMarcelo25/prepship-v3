-- PS-412 â€” finalized billing is immutable.
--
-- `billing_line_items.invoiced` is the durable money/audit boundary. When any
-- line for an order is invoiced, the entire order is frozen. Order-less lines
-- (currently storage) are grouped by client + ship date + line type.
--
-- Additive and idempotent. There is intentionally no bypass in this migration.
-- A future correction workflow must be separately privileged, reason-required,
-- and audited; normal API/admin/script paths all fail closed.

-- This is a monotonic enforcement projection, not a second billing source of
-- truth. Its row lock serializes every transaction touching the same bill so a
-- sibling mutation cannot commit after another transaction finalizes it.
CREATE TABLE IF NOT EXISTS billing_finalization_group_locks (
  group_key text PRIMARY KEY,
  finalized boolean NOT NULL DEFAULT false,
  dirty boolean NOT NULL DEFAULT false
);

ALTER TABLE billing_finalization_group_locks
  ADD COLUMN IF NOT EXISTS dirty boolean NOT NULL DEFAULT false;
ALTER TABLE billing_finalization_group_locks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION billing_line_item_group_key(
  p_client_id integer,
  p_order_id integer,
  p_ship_date timestamptz,
  p_line_type text
) RETURNS text AS $$
  SELECT CASE
    WHEN p_order_id IS NOT NULL THEN
      jsonb_build_array('order', p_client_id, p_order_id)::text
    ELSE
      jsonb_build_array(
        'orderless',
        p_client_id,
        extract(epoch FROM p_ship_date),
        p_line_type
      )::text
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION billing_line_item_lock_group(p_group_key text)
RETURNS boolean AS $$
DECLARE
  was_finalized boolean;
BEGIN
  -- The no-op conflict update takes a transaction-duration row lock and its
  -- RETURNING value observes the latest committed guard state after waiting.
  INSERT INTO billing_finalization_group_locks (group_key, finalized)
  VALUES (p_group_key, false)
  ON CONFLICT (group_key) DO UPDATE
    SET group_key = EXCLUDED.group_key
  RETURNING finalized INTO was_finalized;
  RETURN was_finalized;
END;
$$ LANGUAGE plpgsql VOLATILE;

INSERT INTO billing_finalization_group_locks (group_key, finalized)
SELECT DISTINCT
  billing_line_item_group_key(client_id, order_id, ship_date, line_type),
  true
FROM billing_line_items
WHERE invoiced = true
ON CONFLICT (group_key) DO UPDATE SET finalized = true;

CREATE OR REPLACE FUNCTION billing_line_item_group_is_finalized(
  p_id integer,
  p_client_id integer,
  p_order_id integer,
  p_ship_date timestamptz,
  p_line_type text
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM billing_line_items finalized
    WHERE finalized.invoiced = true
      AND (p_id IS NULL OR finalized.id <> p_id)
      AND (
        (
          p_order_id IS NOT NULL
          AND finalized.client_id = p_client_id
          AND finalized.order_id = p_order_id
        )
        OR
        (
          p_order_id IS NULL
          AND finalized.order_id IS NULL
          AND finalized.client_id = p_client_id
          AND finalized.line_type = p_line_type
          AND finalized.ship_date IS NOT DISTINCT FROM p_ship_date
        )
      )
  );
$$ LANGUAGE sql VOLATILE;

CREATE OR REPLACE FUNCTION billing_line_items_block_finalized_mutation()
RETURNS trigger AS $$
DECLARE
  old_group_key text;
  new_group_key text;
  lock_key text;
  lock_was_finalized boolean;
  old_group_was_finalized boolean := false;
  new_group_was_finalized boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_group_key := billing_line_item_group_key(
      OLD.client_id, OLD.order_id, OLD.ship_date, OLD.line_type
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_group_key := billing_line_item_group_key(
      NEW.client_id, NEW.order_id, NEW.ship_date, NEW.line_type
    );
  END IF;

  -- Lock both identities in deterministic order for the rare editable-row
  -- move. The lock row closes the different-sibling, different-transaction
  -- race that a row trigger alone cannot see.
  FOR lock_key IN
    SELECT DISTINCT candidate_key
    FROM unnest(ARRAY[old_group_key, new_group_key]) AS keys(candidate_key)
    WHERE candidate_key IS NOT NULL
    ORDER BY candidate_key
  LOOP
    lock_was_finalized := billing_line_item_lock_group(lock_key);
    IF lock_key = old_group_key THEN
      old_group_was_finalized := lock_was_finalized;
    END IF;
    IF lock_key = new_group_key THEN
      new_group_was_finalized := lock_was_finalized;
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    IF old_group_was_finalized OR OLD.invoiced = true OR billing_line_item_group_is_finalized(
      OLD.id, OLD.client_id, OLD.order_id, OLD.ship_date, OLD.line_type
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'BILLING_FINALIZED_LOCKED: finalized billing cannot be modified';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Finalization itself is allowed only as a pure false -> true flag change.
    -- Money, identity, package, and date fields cannot change in the same write.
    IF OLD.invoiced = false AND NEW.invoiced = true THEN
      IF (to_jsonb(NEW) - 'invoiced') IS DISTINCT FROM (to_jsonb(OLD) - 'invoiced') THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'BILLING_FINALIZED_LOCKED: finalization cannot change billing values';
      END IF;
      IF EXISTS (
        SELECT 1 FROM billing_finalization_group_locks
        WHERE group_key = new_group_key AND dirty = true
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'BILLING_FINALIZED_LOCKED: regenerate pending billing changes before finalization';
      END IF;
      UPDATE billing_finalization_group_locks
      SET finalized = true
      WHERE group_key = new_group_key;
      RETURN NEW;
    END IF;

    IF old_group_was_finalized OR new_group_was_finalized OR
       OLD.invoiced = true OR billing_line_item_group_is_finalized(
      OLD.id, OLD.client_id, OLD.order_id, OLD.ship_date, OLD.line_type
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'BILLING_FINALIZED_LOCKED: finalized billing cannot be modified';
    END IF;

    IF billing_line_item_group_is_finalized(
      NEW.id, NEW.client_id, NEW.order_id, NEW.ship_date, NEW.line_type
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'BILLING_FINALIZED_LOCKED: finalized billing cannot be modified';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT: never append a new charge to an already-finalized order/period.
  IF new_group_was_finalized OR billing_line_item_group_is_finalized(
    NULL, NEW.client_id, NEW.order_id, NEW.ship_date, NEW.line_type
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_FINALIZED_LOCKED: finalized billing cannot be modified';
  END IF;
  IF NEW.invoiced = true THEN
    IF EXISTS (
      SELECT 1 FROM billing_finalization_group_locks
      WHERE group_key = new_group_key AND dirty = true
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'BILLING_FINALIZED_LOCKED: regenerate pending billing changes before finalization';
    END IF;
    UPDATE billing_finalization_group_locks
    SET finalized = true
    WHERE group_key = new_group_key;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Row triggers see the statement's original snapshot. This statement-level
-- transition-table guard prevents one multi-row UPDATE from finalizing one
-- line while changing money/identity on a sibling in that same statement.
CREATE OR REPLACE FUNCTION billing_line_items_block_mixed_finalization_statement()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM billing_line_items_old old_row
    INNER JOIN billing_line_items_new new_row USING (id)
    WHERE old_row.invoiced = false AND new_row.invoiced = true
  ) AND EXISTS (
    SELECT 1
    FROM billing_line_items_old old_row
    INNER JOIN billing_line_items_new new_row USING (id)
    WHERE (to_jsonb(new_row) - 'invoiced') IS DISTINCT FROM
          (to_jsonb(old_row) - 'invoiced')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_FINALIZED_LOCKED: finalization statement cannot change billing values';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_line_items_finalized_guard'
      AND tgrelid = 'billing_line_items'::regclass
  ) THEN
    CREATE TRIGGER billing_line_items_finalized_guard
      BEFORE INSERT OR UPDATE OR DELETE ON billing_line_items
      FOR EACH ROW EXECUTE FUNCTION billing_line_items_block_finalized_mutation();
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_line_items_mixed_finalization_guard'
      AND tgrelid = 'billing_line_items'::regclass
  ) THEN
    CREATE TRIGGER billing_line_items_mixed_finalization_guard
      AFTER UPDATE ON billing_line_items
      REFERENCING OLD TABLE AS billing_line_items_old
                  NEW TABLE AS billing_line_items_new
      FOR EACH STATEMENT
      EXECUTE FUNCTION billing_line_items_block_mixed_finalization_statement();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION billing_line_items_block_finalized_truncate()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing_line_items WHERE invoiced = true) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BILLING_FINALIZED_LOCKED: finalized billing prevents truncate';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'billing_line_items_finalized_truncate_guard'
      AND tgrelid = 'billing_line_items'::regclass
  ) THEN
    CREATE TRIGGER billing_line_items_finalized_truncate_guard
      BEFORE TRUNCATE ON billing_line_items
      FOR EACH STATEMENT EXECUTE FUNCTION billing_line_items_block_finalized_truncate();
  END IF;
END;
$$;
