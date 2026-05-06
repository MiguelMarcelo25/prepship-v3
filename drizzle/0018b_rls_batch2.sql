-- ============================================================================
-- Batch 2 of 3 — RLS on 8 more tables
-- ============================================================================

ALTER TABLE public.print_queue_orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_package_prices  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packages               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_ledger         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_defaults       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_meta              ENABLE ROW LEVEL SECURITY;
