-- Audit B-9: one durable row per logical reference-rate identity. Keep the
-- newest historical row before adding the constraint so migration-first deploys
-- can upgrade databases that already contain append-only duplicates.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY weight_oz, zip_to, carrier, service
      ORDER BY fetched_at DESC, id DESC
    ) AS duplicate_rank
  FROM billing_ref_rates
)
DELETE FROM billing_ref_rates AS rates
USING ranked
WHERE rates.id = ranked.id
  AND ranked.duplicate_rank > 1;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'billing_ref_rates_identity_unq'
      AND conrelid = 'billing_ref_rates'::regclass
  ) THEN
    ALTER TABLE billing_ref_rates
      ADD CONSTRAINT billing_ref_rates_identity_unq
      UNIQUE NULLS NOT DISTINCT (weight_oz, zip_to, carrier, service);
  END IF;
END
$$;
