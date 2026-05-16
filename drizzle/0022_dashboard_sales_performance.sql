-- Dashboard aggregate hot-path indexes.
--
-- /orders/dashboard-sales scans a date window, skips cancelled orders, and
-- optionally filters by client. These indexes keep the dashboard from falling
-- back to a broad orders scan before expanding items[] for SKU/revenue totals.

CREATE INDEX IF NOT EXISTS "orders_dashboard_sales_date_idx"
  ON "orders" ("order_date" DESC)
  WHERE "order_status" <> 'cancelled';

CREATE INDEX IF NOT EXISTS "orders_dashboard_sales_client_date_idx"
  ON "orders" ("client_id", "order_date" DESC)
  WHERE "order_status" <> 'cancelled';

ANALYZE "orders";
