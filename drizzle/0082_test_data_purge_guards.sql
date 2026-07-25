-- Test-client cleanup is the one narrow exception to append-only operational
-- history. The API must set app.test_data_purge=on for the current transaction,
-- and every row is independently proven to belong to clients.is_test=true.
-- Real client history remains immutable even if a caller sets the GUC.
-- Per user override unlock shipped data on 2026-07-25: this exception is
-- limited to consistently test-owned rows and never authorizes mixed ownership.

CREATE OR REPLACE FUNCTION public.test_data_purge_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('app.test_data_purge', true) = 'on';
$$;

CREATE OR REPLACE FUNCTION public.test_data_purge_order_allowed(target_order_id integer)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.test_data_purge_enabled()
    AND EXISTS (
      SELECT 1
      FROM public.orders target_order
      JOIN public.clients target_client ON target_client.id = target_order.client_id
      WHERE target_order.id = target_order_id
        AND target_client.is_test = true
    );
$$;

CREATE OR REPLACE FUNCTION public.test_data_purge_client_allowed(target_client_id integer)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.test_data_purge_enabled()
    AND EXISTS (
      SELECT 1
      FROM public.clients target_client
      WHERE target_client.id = target_client_id
        AND target_client.is_test = true
    );
$$;

CREATE OR REPLACE FUNCTION public.test_data_purge_inventory_allowed(target_inventory_id integer)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.test_data_purge_enabled()
    AND EXISTS (
      SELECT 1
      FROM public.inventory target_inventory
      JOIN public.clients target_client ON target_client.id = target_inventory.client_id
      WHERE target_inventory.id = target_inventory_id
        AND target_client.is_test = true
    );
$$;

CREATE OR REPLACE FUNCTION public.test_data_purge_shipment_allowed(target_shipment_id integer)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.test_data_purge_enabled()
    AND EXISTS (
      SELECT 1
      FROM public.shipments target_shipment
      LEFT JOIN public.orders target_order ON target_order.id = target_shipment.order_id
      LEFT JOIN public.clients shipment_client ON shipment_client.id = target_shipment.client_id
      LEFT JOIN public.clients order_client ON order_client.id = target_order.client_id
      WHERE target_shipment.id = target_shipment_id
        AND (coalesce(shipment_client.is_test, false) OR coalesce(order_client.is_test, false))
        AND (shipment_client.id IS NULL OR shipment_client.is_test = true)
        AND (order_client.id IS NULL OR order_client.is_test = true)
    );
$$;

CREATE OR REPLACE FUNCTION public.inventory_ledger_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.test_data_purge_enabled()
       AND (OLD.order_id IS NULL OR public.test_data_purge_order_allowed(OLD.order_id))
       AND (OLD.inventory_id IS NULL OR public.test_data_purge_inventory_allowed(OLD.inventory_id))
       AND (OLD.client_id IS NULL OR public.test_data_purge_client_allowed(OLD.client_id))
       AND (
         OLD.order_id IS NOT NULL
         OR OLD.inventory_id IS NOT NULL
         OR OLD.client_id IS NOT NULL
       ) THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'PS462_INVENTORY_LEDGER_IMMUTABLE: append an idempotent reversal movement';
END;
$$;

CREATE OR REPLACE FUNCTION public.order_lifecycle_events_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.test_data_purge_order_allowed(OLD.order_id) THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'order_lifecycle_events is append-only';
END;
$$;

CREATE OR REPLACE FUNCTION public.shipment_hazmat_snapshots_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.capture_kind = 'test_label'
       AND public.test_data_purge_shipment_allowed(OLD.shipment_id) THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'shipment_hazmat_snapshots is append-only';
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_line_items_block_adjustment_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.test_data_purge_client_allowed(OLD.client_id)
       AND (OLD.order_id IS NULL OR public.test_data_purge_order_allowed(OLD.order_id))
       AND (OLD.shipment_id IS NULL OR public.test_data_purge_shipment_allowed(OLD.shipment_id)) THEN
      RETURN OLD;
    END IF;
  END IF;

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
$$;

CREATE OR REPLACE FUNCTION public.billing_line_items_block_closed_period_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  lock_client_id integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.test_data_purge_client_allowed(OLD.client_id)
       AND (OLD.order_id IS NULL OR public.test_data_purge_order_allowed(OLD.order_id))
       AND (OLD.shipment_id IS NULL OR public.test_data_purge_shipment_allowed(OLD.shipment_id)) THEN
      RETURN OLD;
    END IF;
  END IF;

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
    FROM public.billing_finalizations closed
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
    FROM public.billing_finalizations closed
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
$$;

CREATE OR REPLACE FUNCTION public.billing_close_records_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.test_data_purge_client_allowed(OLD.client_id) THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'BILLING_CLOSE_IMMUTABLE: billing close records are append-only';
END;
$$;
