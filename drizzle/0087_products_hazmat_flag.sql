-- Marks a SKU as a dangerous good.
--
-- A CATALOG FACT, not a declaration. It records that shipping this item is
-- regulated. It does NOT declare any order hazmat and never writes to
-- order_hazmat_declarations -- that table stays the single source of truth for
-- what a shipment declares, keeps its own revision and audit trail, and remains
-- gated by the hazmat canary flags. A catalog checkbox must not be able to
-- bypass any of that.
--
-- It exists so an operator can see which line made an order hazmat, and so
-- automation rules can match on the fact instead of hard-coding SKU strings
-- into every rule.
--
-- NOT NULL DEFAULT false, so existing rows are backfilled to "not hazmat" and
-- no read can return null. Apply this BEFORE deploying the code: drizzle emits
-- every mapped column on a bare select(), so the new build would 500 on every
-- product read against a table that does not have the column yet.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS hazmat boolean NOT NULL DEFAULT false;

-- Partial: the hazmat SKUs are the rare ones, and every read of this flag asks
-- "which of these are hazmat", never "which are not".
CREATE INDEX IF NOT EXISTS products_hazmat_idx
  ON products (sku) WHERE hazmat;
