-- PS-462 emergency forward rollback after 0076_inventory_quantity_cutover.sql.
-- This is NOT part of the normal migration chain. Run only while API/worker inventory
-- writes are stopped and INVENTORY_AUTO_DEDUCT=false, immediately before deploying the
-- prior stock_qty-compatible runtime. The immutable signed ledger remains authoritative.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  has_stock_qty boolean;
  already_applied boolean;
BEGIN
  IF to_regclass('public.inventory') IS NULL OR to_regclass('public.inventory_ledger') IS NULL THEN
    RAISE EXCEPTION 'PS462_FORWARD_ROLLBACK_SCHEMA_MISSING';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'stock_qty'
  ) INTO has_stock_qty;

  SELECT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = to_regprocedure('public.inventory_ledger_prepare_insert()')
      AND pg_get_functiondef(oid) LIKE '%PS462_FORWARD_ROLLBACK_ACTIVE%'
  ) INTO already_applied;

  IF has_stock_qty AND NOT already_applied THEN
    RAISE EXCEPTION 'PS462_FORWARD_ROLLBACK_REQUIRES_0076';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND NOT tgisinternal
      AND tgname = 'inventory_ledger_no_update_delete'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND NOT tgisinternal
      AND tgname = 'inventory_ledger_no_truncate'
  ) THEN
    RAISE EXCEPTION 'PS462_FORWARD_ROLLBACK_IMMUTABILITY_NOT_READY';
  END IF;
END $$;

ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS stock_qty integer;

WITH ledger_quantity AS (
  SELECT inventory_id, COALESCE(SUM(qty), 0)::int AS quantity
  FROM public.inventory_ledger
  GROUP BY inventory_id
)
UPDATE public.inventory item
SET stock_qty = COALESCE(ledger_quantity.quantity, 0)
FROM (SELECT id FROM public.inventory) inventory_scope
LEFT JOIN ledger_quantity ON ledger_quantity.inventory_id = inventory_scope.id
WHERE item.id = inventory_scope.id;

ALTER TABLE public.inventory ALTER COLUMN stock_qty SET DEFAULT 0;
ALTER TABLE public.inventory ALTER COLUMN stock_qty SET NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.inventory_risk_metrics') IS NOT NULL THEN
    ALTER TABLE public.inventory_risk_metrics ADD COLUMN IF NOT EXISTS stock_qty integer;
    ALTER TABLE public.inventory_risk_metrics ADD COLUMN IF NOT EXISTS effective_stock integer;

    UPDATE public.inventory_risk_metrics metric
    SET stock_qty = item.stock_qty,
        effective_stock = item.stock_qty
    FROM public.inventory item
    WHERE item.id = metric.inventory_id;

    UPDATE public.inventory_risk_metrics
    SET stock_qty = COALESCE(stock_qty, 0),
        effective_stock = COALESCE(effective_stock, 0)
    WHERE stock_qty IS NULL OR effective_stock IS NULL;

    ALTER TABLE public.inventory_risk_metrics ALTER COLUMN stock_qty SET DEFAULT 0;
    ALTER TABLE public.inventory_risk_metrics ALTER COLUMN stock_qty SET NOT NULL;
    ALTER TABLE public.inventory_risk_metrics ALTER COLUMN effective_stock SET DEFAULT 0;
    ALTER TABLE public.inventory_risk_metrics ALTER COLUMN effective_stock SET NOT NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.inventory_ledger_prepare_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  owner_client_id integer;
  owner_sku text;
  compatibility_marker constant text := 'PS462_FORWARD_ROLLBACK_ACTIVE';
BEGIN
  SELECT client_id, sku INTO owner_client_id, owner_sku
  FROM public.inventory WHERE id = NEW.inventory_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PS462_INVENTORY_IDENTITY_NOT_FOUND'; END IF;

  NEW.client_id := owner_client_id;
  NEW.sku := owner_sku;

  -- The recorded pre-cutover runtime omitted identity on manual receive/adjust.
  -- PostgreSQL has already assigned NEW.id before this BEFORE INSERT trigger,
  -- so the compatibility identity is stable for the one persisted movement and
  -- cannot collide with another legacy row.
  IF NULLIF(BTRIM(NEW.idempotency_key), '') IS NULL THEN
    NEW.idempotency_key := 'legacy_inventory_runtime:ledger:' || NEW.id::text;
  END IF;

  IF NULLIF(BTRIM(NEW.source_entity), '') IS NULL
     AND NULLIF(BTRIM(NEW.idempotency_key), '') IS NOT NULL THEN
    NEW.source_entity := 'legacy_inventory_runtime';
  END IF;
  IF NULLIF(BTRIM(NEW.source_id), '') IS NULL
     AND NULLIF(BTRIM(NEW.idempotency_key), '') IS NOT NULL THEN
    NEW.source_id := NEW.idempotency_key;
  END IF;

  NEW.effective_at := COALESCE(NEW.effective_at, NEW.created_at, clock_timestamp());
  NEW.created_by := COALESCE(NULLIF(BTRIM(NEW.created_by), ''), 'legacy_inventory_runtime');

  IF NEW.effective_at IS NULL OR NULLIF(BTRIM(NEW.created_by), '') IS NULL
     OR NULLIF(BTRIM(NEW.idempotency_key), '') IS NULL
     OR NULLIF(BTRIM(NEW.source_entity), '') IS NULL
     OR NULLIF(BTRIM(NEW.source_id), '') IS NULL THEN
    RAISE EXCEPTION 'PS462_INVENTORY_MOVEMENT_IDENTITY_REQUIRED';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS inventory_ledger_prepare_insert_guard ON public.inventory_ledger;
CREATE TRIGGER inventory_ledger_prepare_insert_guard
BEFORE INSERT ON public.inventory_ledger
FOR EACH ROW EXECUTE FUNCTION public.inventory_ledger_prepare_insert();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.inventory item
    LEFT JOIN (
      SELECT inventory_id, COALESCE(SUM(qty), 0)::int AS quantity
      FROM public.inventory_ledger
      GROUP BY inventory_id
    ) ledger_quantity ON ledger_quantity.inventory_id = item.id
    WHERE item.stock_qty IS DISTINCT FROM COALESCE(ledger_quantity.quantity, 0)
  ) THEN
    RAISE EXCEPTION 'PS462_FORWARD_ROLLBACK_PARITY_FAILED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND NOT tgisinternal
      AND tgname = 'inventory_ledger_no_update_delete'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND NOT tgisinternal
      AND tgname = 'inventory_ledger_no_truncate'
  ) THEN
    RAISE EXCEPTION 'PS462_FORWARD_ROLLBACK_IMMUTABILITY_LOST';
  END IF;
END $$;

COMMIT;
