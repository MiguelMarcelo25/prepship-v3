-- PS-439: one ledger-derived inventory quantity and immutable movement history.
-- This migration never invents opening balances. It stops before dropping the legacy
-- cache if the read-only comparison finds any mismatch, so a reviewed movement plan is
-- required before cutover rather than silently choosing a legacy winner.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'stock_qty'
  ) AND EXISTS (
    SELECT 1
    FROM public.inventory i
    LEFT JOIN (
      SELECT inventory_id, COALESCE(SUM(qty), 0)::int AS inventory_quantity
      FROM public.inventory_ledger
      GROUP BY inventory_id
    ) ledger ON ledger.inventory_id = i.id
    WHERE i.stock_qty IS DISTINCT FROM COALESCE(ledger.inventory_quantity, 0)
  ) THEN
    RAISE EXCEPTION 'PS439_INVENTORY_CUTOVER_BLOCKED: run the read-only discrepancy report and obtain approval for any opening/correction movements';
  END IF;
END $$;

ALTER TABLE public.inventory_ledger ADD COLUMN IF NOT EXISTS client_id integer REFERENCES public.clients(id);
ALTER TABLE public.inventory_ledger ADD COLUMN IF NOT EXISTS sku text;
ALTER TABLE public.inventory_ledger ADD COLUMN IF NOT EXISTS source_entity text;
ALTER TABLE public.inventory_ledger ADD COLUMN IF NOT EXISTS source_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_ledger_nonzero_qty_chk'
      AND conrelid = 'public.inventory_ledger'::regclass
  ) THEN
    ALTER TABLE public.inventory_ledger
      ADD CONSTRAINT inventory_ledger_nonzero_qty_chk CHECK (qty <> 0) NOT VALID;
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
BEGIN
  SELECT client_id, sku INTO owner_client_id, owner_sku
  FROM public.inventory WHERE id = NEW.inventory_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PS439_INVENTORY_IDENTITY_NOT_FOUND'; END IF;
  NEW.client_id := owner_client_id;
  NEW.sku := owner_sku;
  IF NEW.effective_at IS NULL OR NULLIF(BTRIM(NEW.created_by), '') IS NULL
     OR NULLIF(BTRIM(NEW.idempotency_key), '') IS NULL
     OR NULLIF(BTRIM(NEW.source_entity), '') IS NULL
     OR NULLIF(BTRIM(NEW.source_id), '') IS NULL THEN
    RAISE EXCEPTION 'PS439_INVENTORY_MOVEMENT_IDENTITY_REQUIRED';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS inventory_ledger_prepare_insert_guard ON public.inventory_ledger;
CREATE TRIGGER inventory_ledger_prepare_insert_guard
BEFORE INSERT ON public.inventory_ledger
FOR EACH ROW EXECUTE FUNCTION public.inventory_ledger_prepare_insert();

CREATE OR REPLACE FUNCTION public.inventory_ledger_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'PS439_INVENTORY_LEDGER_IMMUTABLE: append an idempotent reversal movement';
END $$;

DROP TRIGGER IF EXISTS inventory_ledger_no_update_delete ON public.inventory_ledger;
CREATE TRIGGER inventory_ledger_no_update_delete
BEFORE UPDATE OR DELETE ON public.inventory_ledger
FOR EACH ROW EXECUTE FUNCTION public.inventory_ledger_block_mutations();

DROP TRIGGER IF EXISTS inventory_ledger_no_truncate ON public.inventory_ledger;
CREATE TRIGGER inventory_ledger_no_truncate
BEFORE TRUNCATE ON public.inventory_ledger
FOR EACH STATEMENT EXECUTE FUNCTION public.inventory_ledger_block_mutations();

CREATE UNIQUE INDEX IF NOT EXISTS inventory_ledger_source_identity_unq
ON public.inventory_ledger (source_entity, source_id, inventory_id, type)
WHERE source_entity IS NOT NULL AND source_id IS NOT NULL;

ALTER TABLE IF EXISTS public.inventory_risk_metrics DROP COLUMN IF EXISTS stock_qty;
ALTER TABLE IF EXISTS public.inventory_risk_metrics DROP COLUMN IF EXISTS effective_stock;
ALTER TABLE public.inventory DROP COLUMN IF EXISTS stock_qty;
