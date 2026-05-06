-- ============================================================================
-- Add 3 indexes for unindexed foreign keys
-- ============================================================================
-- IMPORTANT: Paste and Run each statement INDIVIDUALLY (one at a time).
-- CREATE INDEX CONCURRENTLY cannot run in a transaction block — if you paste
-- all 3 at once the editor wraps them and Postgres rejects it.
--
-- CONCURRENTLY = builds the index without locking the table. Slower to build
-- but the app keeps working during the build. On a busy table, this is the
-- safe default.
-- ============================================================================

-- ─── Run this one alone ─────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_li_shipment_idx
  ON public.billing_line_items (shipment_id)
  WHERE shipment_id IS NOT NULL;


-- ─── Then this one alone ────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_li_order_idx
  ON public.billing_line_items (order_id)
  WHERE order_id IS NOT NULL;


-- ─── Then this one alone ────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_ledger_order_idx
  ON public.inventory_ledger (order_id)
  WHERE order_id IS NOT NULL;
