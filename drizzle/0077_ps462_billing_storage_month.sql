-- PS-462: storage is one backend-owned fact per client + UTC calendar month.
-- Additive/fail-closed: this migration never deletes or rewrites billing rows.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.billing_line_items
    WHERE order_id IS NULL
      AND line_type = 'storage'
      AND ship_date IS NOT NULL
    GROUP BY client_id, date_trunc('month', ship_date AT TIME ZONE 'UTC')
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'PS462_STORAGE_MONTH_DUPLICATES: review the read-only discrepancy report before creating the monthly identity index';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS billing_li_storage_month_unq
ON public.billing_line_items (
  client_id,
  (date_trunc('month', ship_date AT TIME ZONE 'UTC'))
)
WHERE order_id IS NULL
  AND line_type = 'storage'
  AND ship_date IS NOT NULL;
