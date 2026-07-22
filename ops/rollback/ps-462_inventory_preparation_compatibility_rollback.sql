-- PS-462 phase-1 compatibility rollback only.
-- Use during maintenance when 0075 committed but the compatible runtime cannot deploy.
-- This restores the prior insert shape without editing ledger history or weakening the
-- UPDATE/DELETE/TRUNCATE immutability triggers.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('public.inventory_ledger') IS NULL THEN
    RAISE EXCEPTION 'PS462_PREPARATION_ROLLBACK_LEDGER_NOT_FOUND';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'stock_qty'
  ) THEN
    RAISE EXCEPTION 'PS462_PREPARATION_ROLLBACK_REQUIRES_PRE_CUTOVER';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND tgname = 'inventory_ledger_no_update_delete'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND tgname = 'inventory_ledger_no_truncate'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'PS462_PREPARATION_ROLLBACK_IMMUTABILITY_NOT_READY';
  END IF;
END $$;

DROP TRIGGER IF EXISTS inventory_ledger_prepare_insert_guard ON public.inventory_ledger;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND tgname = 'inventory_ledger_prepare_insert_guard'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'PS462_PREPARATION_ROLLBACK_INSERT_GUARD_STILL_PRESENT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND tgname = 'inventory_ledger_no_update_delete'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND tgname = 'inventory_ledger_no_truncate'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'PS462_PREPARATION_ROLLBACK_WEAKENED_IMMUTABILITY';
  END IF;
END $$;

COMMIT;
