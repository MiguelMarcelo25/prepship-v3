-- ============================================================================
-- STATUS CHECK — run this FIRST in Supabase SQL Editor
-- ============================================================================
-- The previous migration timed out. Some statements may have already committed.
-- This query shows you exactly what's done and what's still pending.
-- ============================================================================

-- 1. Which of the 24 target tables now have RLS enabled?
WITH target_tables(name) AS (
  VALUES
    ('sku_qty_dims'), ('settings'), ('orders'), ('locations'),
    ('inventory_ledger'), ('billing_ref_rates'), ('parent_skus'),
    ('billing_line_items'), ('print_queue_orders'), ('client_package_prices'),
    ('packages'), ('inventory'), ('package_ledger'), ('product_defaults'),
    ('clients'), ('sync_meta'), ('billing_config'), ('mock_labels'),
    ('return_labels'), ('inventory_sku_parents'), ('products'), ('rate_cache'),
    ('order_overrides'), ('shipments')
)
SELECT
  t.name                       AS table_name,
  COALESCE(c.relrowsecurity, false) AS rls_enabled,
  CASE WHEN c.relrowsecurity THEN '✅ done' ELSE '⏳ pending' END AS status
FROM target_tables t
LEFT JOIN pg_class c
  ON c.relname = t.name
 AND c.relnamespace = 'public'::regnamespace
ORDER BY rls_enabled DESC, table_name;
