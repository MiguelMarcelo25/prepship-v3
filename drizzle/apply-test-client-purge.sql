-- ────────────────────────────────────────────────────────────────────────
-- One-time cleanup + flip for sandbox / test clients.
-- Run this in the Supabase SQL editor AFTER applying migration 0013
-- (drizzle/0013_sweet_nico_minoru.sql — adds clients.is_test column).
--
-- What it does:
--   1. Lists every client whose name contains "test" (case-insensitive).
--   2. Deletes their billing line items, inventory ledger entries, and
--      shipments tied to their orders, then the orders themselves.
--      order_overrides cascades automatically.
--   3. Flips those clients to is_test=true so the sandbox guards kick in.
-- ────────────────────────────────────────────────────────────────────────

-- 1. Verify first — confirm these are the clients you want to wipe.
SELECT id, name, active FROM clients
WHERE lower(name) LIKE '%test%';

-- 2. Purge (transaction-wrapped so everything succeeds or nothing does).
BEGIN;

WITH target_clients AS (
  SELECT id FROM clients WHERE lower(name) LIKE '%test%'
),
target_orders AS (
  SELECT id FROM orders WHERE client_id IN (SELECT id FROM target_clients)
)
DELETE FROM billing_line_items
WHERE order_id IN (SELECT id FROM target_orders);

DELETE FROM inventory_ledger
WHERE order_id IN (
  SELECT id FROM orders WHERE client_id IN (
    SELECT id FROM clients WHERE lower(name) LIKE '%test%'
  )
);

DELETE FROM shipments
WHERE order_id IN (
  SELECT id FROM orders WHERE client_id IN (
    SELECT id FROM clients WHERE lower(name) LIKE '%test%'
  )
);

DELETE FROM orders
WHERE client_id IN (SELECT id FROM clients WHERE lower(name) LIKE '%test%');

-- 3. Flag the clients so they're permanently sandboxed going forward.
UPDATE clients
SET is_test = true, updated_at = now()
WHERE lower(name) LIKE '%test%';

COMMIT;

-- 4. Sanity-check the result.
SELECT id, name, is_test
FROM clients
WHERE is_test = true
ORDER BY name;

SELECT
  (SELECT count(*) FROM orders WHERE client_id IN (SELECT id FROM clients WHERE is_test = true)) AS test_orders_remaining,
  (SELECT count(*) FROM shipments WHERE client_id IN (SELECT id FROM clients WHERE is_test = true)) AS test_shipments_remaining,
  (SELECT count(*) FROM billing_line_items WHERE client_id IN (SELECT id FROM clients WHERE is_test = true)) AS test_billing_remaining;
-- Expect all three to be 0.
