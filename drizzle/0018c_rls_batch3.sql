-- ============================================================================
-- Batch 3 of 3 — RLS on the final 8 tables
-- ============================================================================

ALTER TABLE public.billing_config         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mock_labels            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_labels          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_sku_parents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_cache             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_overrides        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipments              ENABLE ROW LEVEL SECURITY;
