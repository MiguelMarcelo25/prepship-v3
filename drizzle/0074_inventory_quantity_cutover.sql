-- PS-462 phase 2 (renumbered from duplicate PS-439): remove legacy inventory
-- quantity caches only after reconciliation.
-- This migration never invents or applies a correction. A separately reviewed,
-- append-only movement packet must make every legacy balance equal the ledger first.

DO $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_ledger'
      AND column_name IN ('client_id', 'sku', 'source_entity', 'source_id')
  ) <> 4 OR (
    SELECT COUNT(*)
    FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND NOT tgisinternal
      AND tgname IN (
        'inventory_ledger_prepare_insert_guard',
        'inventory_ledger_no_update_delete',
        'inventory_ledger_no_truncate'
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'PS439_INVENTORY_CUTOVER_SCHEMA_NOT_READY: apply 0073_inventory_quantity_sot.sql before cutover';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.inventory_ledger'::regclass
      AND conname = 'inventory_ledger_nonzero_qty_chk'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'inventory_ledger'
      AND indexname = 'inventory_ledger_idempotency_key_unq'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'inventory_ledger'
      AND indexname = 'inventory_ledger_source_identity_unq'
  ) THEN
    RAISE EXCEPTION 'PS439_INVENTORY_CUTOVER_SCHEMA_NOT_READY: ledger constraints and identity indexes are incomplete';
  END IF;
END $$;

DO $$
DECLARE
  has_mismatch boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'stock_qty'
  ) THEN
    EXECUTE $query$
      SELECT EXISTS (
        SELECT 1
        FROM public.inventory i
        LEFT JOIN (
          SELECT inventory_id, COALESCE(SUM(qty), 0)::int AS inventory_quantity
          FROM public.inventory_ledger
          GROUP BY inventory_id
        ) ledger ON ledger.inventory_id = i.id
        WHERE i.stock_qty IS DISTINCT FROM COALESCE(ledger.inventory_quantity, 0)
      )
    $query$ INTO has_mismatch;
    IF has_mismatch THEN
      RAISE EXCEPTION 'PS439_INVENTORY_CUTOVER_BLOCKED: run the read-only discrepancy report and obtain approval for any opening/correction movements';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.inventory_ledger WHERE qty = 0
  ) THEN
    RAISE EXCEPTION 'PS439_INVENTORY_CUTOVER_ZERO_MOVEMENT: reverse invalid history with a reviewed append-only correction';
  END IF;
END $$;

ALTER TABLE public.inventory_ledger
  VALIDATE CONSTRAINT inventory_ledger_nonzero_qty_chk;

ALTER TABLE IF EXISTS public.inventory_risk_metrics DROP COLUMN IF EXISTS stock_qty;
ALTER TABLE IF EXISTS public.inventory_risk_metrics DROP COLUMN IF EXISTS effective_stock;
ALTER TABLE IF EXISTS public.inventory DROP COLUMN IF EXISTS stock_qty;
