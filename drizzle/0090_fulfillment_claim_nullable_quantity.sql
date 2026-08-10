-- PS-497 — a claim may carry a quantity only when the lifecycle owner proved one.
--
-- The existing `quantity integer NOT NULL` plus `CHECK (quantity > 0)` is exactly what forced
-- the normalizer to invent a `1` for every unusable provider value. Production carries 2,950
-- review claims holding that fabricated 1, and one `invalid_quantity` claim whose real value
-- is now unrecoverable.
--
-- This widens the column and replaces the blanket positive check with a STATE check:
--
--   * a usable quantity is still a positive integer, exactly as before;
--   * NULL is legal only while the claim sits in `review`.
--
-- So nothing pending, applied, superseded or reversed can carry an unknown quantity into an
-- inventory movement, and a review claim can only be promoted by supplying a real quantity in
-- the same statement.
--
-- Additive and non-destructive: no row is read, written, or deleted, and no existing value
-- changes. Every current row satisfies the new constraint because every current row has a
-- positive quantity. Re-nulling the historical fabricated 1s is a SEPARATE, DJ-approved
-- backfill and is deliberately not part of this migration.

ALTER TABLE fulfillment_line_claims
  DROP CONSTRAINT IF EXISTS fulfillment_line_claims_quantity_check;

ALTER TABLE fulfillment_line_claims
  ALTER COLUMN quantity DROP NOT NULL;

ALTER TABLE fulfillment_line_claims
  ADD CONSTRAINT fulfillment_line_claims_quantity_state_check
  CHECK (
    (quantity IS NOT NULL AND quantity > 0)
    OR
    (quantity IS NULL AND status = 'review')
  );
