-- ============================================================================
-- Batch 1 of 3 — RLS on 8 tables
-- ============================================================================
-- Paste, click Run. Should complete in ~1 second.
-- If any table already has RLS, the statement is a no-op (safe to re-run).
-- If you get "permission denied", the table doesn't exist or you're not the owner.
-- ============================================================================

ALTER TABLE public.sku_qty_dims           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_ledger       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_ref_rates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_skus            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_line_items     ENABLE ROW LEVEL SECURITY;
