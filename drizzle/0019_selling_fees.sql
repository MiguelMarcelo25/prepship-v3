-- ──────────────────────────────────────────────────────────────────
-- 0019_selling_fees.sql
--
-- Per-order selling-fee tracking. Populated by the per-marketplace
-- fees fetcher (api/carriers/walmart/fees.ts for Walmart; eBay
-- /sell.finances and others come later). Powers the Analysis page's
-- new "Selling Fees" + "Profit" columns: profit = revenue -
-- shipping - fees (COGS layered in later when per-SKU cost is
-- present on inventory rows).
--
-- Columns:
--   selling_fee            numeric  total of all per-order fees the
--                                   marketplace charged us. Sum of
--                                   commission + shipping commission
--                                   + processing + any other
--                                   deductions returned by the
--                                   settlement endpoint.
--   selling_fee_breakdown  jsonb    per-fee-type detail so a future
--                                   tooltip / billing-export can
--                                   show "Commission $X.XX,
--                                   Processing $Y.YY" without
--                                   re-fetching. Shape:
--                                   { commission, shippingCommission,
--                                     processingFee, other }
--   selling_fee_synced_at  timestamptz  last time fees were pulled
--                                       for this order (operator
--                                       confidence + stale-data check)
--   selling_fee_source     text     'walmart' | 'ebay' | … so a
--                                   re-sync uses the right endpoint.
--
-- Lockdown note (AGENTS.md): populating these columns INVOLVES
-- writing to shipped/cancelled orders (fees settle after delivery).
-- Operator typed `unlock shipped data` on 2026-05-12 in this
-- conversation, and the rename-propagation commit (0d0f1ac) +
-- carrier-edit feature operate under that ongoing override. This
-- migration only adds DDL — no data movement — but the subsequent
-- fees fetcher UPDATEs shipped orders, which is the locked surface
-- the override enables.
-- ──────────────────────────────────────────────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS selling_fee NUMERIC(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS selling_fee_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS selling_fee_synced_at TIMESTAMPTZ;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS selling_fee_source TEXT;

-- Index speeds up the per-marketplace re-sync flow (find orders for
-- this client that need fee data). Partial index because the column
-- is null for orders that haven't been synced yet — Postgres skips
-- the null rows.
CREATE INDEX IF NOT EXISTS orders_selling_fee_source_idx
  ON orders (selling_fee_source)
  WHERE selling_fee_source IS NOT NULL;
