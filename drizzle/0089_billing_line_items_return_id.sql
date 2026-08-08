-- PS-488 M1 — relational return identity on billing lines.
--
-- WHY A COLUMN AND NOT A LOOKUP
--
-- A return's billing lines are currently only findable by parsing the event key
-- (`return:<id>:<kind>`) out of `description`. That is a string field carrying identity,
-- and PS-487 AC-7 needs to record WHICH billing rows a date correction affected. An
-- audit trail built on parsed prose is not relational evidence.
--
-- The obvious alternative — order_id + line_type — is unsafe rather than merely
-- inelegant. It is unambiguous today only because no order yet has two returns:
-- returns_one_active_per_order_idx prevents two ACTIVE returns per order, but a second
-- return after the first closes is legitimate. The first time that happens, an audit
-- keyed that way silently attributes one return's charges to another. On a money
-- surface a linkage that mis-attributes later is worse than an admitted gap.
--
-- SAFETY
--
-- Additive and nullable. Every existing row keeps NULL, no backfill runs here, and no
-- reader changes behaviour because of this migration alone. M1 only creates the place to
-- put the identity; M2 makes the writers populate it. Between the two, the column is
-- deliberately empty — code must not treat NULL as "no return", only as "not yet
-- attributed", until M2 has shipped and been proved on deployed writers.
--
-- ON DELETE SET NULL, not CASCADE: a billing line is financial history. Deleting a
-- return must never delete the charge it produced, and a frozen invoice row must survive
-- its return record being removed.
ALTER TABLE "billing_line_items"
  ADD COLUMN IF NOT EXISTS "return_id" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'billing_line_items_return_id_returns_id_fk'
  ) THEN
    ALTER TABLE "billing_line_items"
      ADD CONSTRAINT "billing_line_items_return_id_returns_id_fk"
      FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint
-- Partial index: the only query this column exists to serve is "which billing rows belong
-- to this return", and NULL rows (every pre-M2 row, plus every non-return line forever)
-- are never the answer.
CREATE INDEX IF NOT EXISTS "billing_li_return_id_idx"
  ON "billing_line_items" ("return_id")
  WHERE "return_id" IS NOT NULL;
