-- ============================================================================
-- Add PRIMARY KEY to client_package_prices
-- ============================================================================
-- Pre-check first: paste THIS query alone and run.
-- ============================================================================

-- STEP 1 — verify no duplicates exist (must return 0 rows)
SELECT client_id, package_id, COUNT(*) AS dup_count
FROM client_package_prices
GROUP BY client_id, package_id
HAVING COUNT(*) > 1;

-- ─── If the above returned 0 rows, run this next: ──────────────────────────

-- STEP 2 — add the primary key (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.client_package_prices'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.client_package_prices
      ADD CONSTRAINT client_package_prices_pkey
      PRIMARY KEY (client_id, package_id);

    DROP INDEX IF EXISTS public.client_package_prices_pk_idx;
  END IF;
END $$;
