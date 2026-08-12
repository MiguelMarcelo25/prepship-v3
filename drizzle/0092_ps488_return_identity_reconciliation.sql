-- PS-488 M1 recovery — reconcile the return-identity contract, forward only.
--
-- WHY THIS EXISTS
--
-- 0089 shipped `billing_line_items.return_id` to production with an incomplete
-- contract. Three governed pieces are missing or wrong:
--   * the FK deletes with ON DELETE SET NULL, so removing a return would silently
--     detach the billing rows it produced instead of refusing;
--   * the raw partial UNIQUE (return_id, line_type) is absent, so one return could
--     accumulate two postage rows or two processing rows;
--   * the semantic CHECK is absent, so a legacy line type could be attached to a
--     return_id and be read as canonical.
--
-- 0089 IS IMMUTABLE HISTORY. It is not edited, not replayed, not reverted, and
-- return_id is not dropped. This migration repairs forward under a new number.
--
-- NO DATA IS TOUCHED. There is no INSERT, UPDATE, DELETE or backfill here, and no
-- billing regeneration. Row count, money and per-row checksum are unchanged by
-- construction; the runner asserts that rather than trusting this comment.
--
-- LOCKING
--
-- lock_timeout 5s and statement_timeout 120s are frozen by Hermes. The unique index
-- is built NON-CONCURRENTLY on purpose: CREATE INDEX CONCURRENTLY cannot run inside
-- a transaction, and the reviewed contract requires the whole reconciliation —
-- verification, DDL and assertions — to succeed or roll back as one unit. A bounded
-- lock_timeout is what makes that safe: under contention this fails fast and rolls
-- back rather than holding billing writes open.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- Guard: the column must still be the additive nullable integer 0089 created. A
-- default or a generated expression would mean something else has already rewritten
-- this column, and reconciling on top of that would be guesswork.
DO $$
DECLARE
  col record;
BEGIN
  SELECT a.attnotnull AS notnull, a.atthasdef AS hasdef, a.attgenerated AS generated, t.typname AS typ
    INTO col
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE n.nspname = 'public'
    AND c.relname = 'billing_line_items'
    AND a.attname = 'return_id'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF col IS NULL THEN
    RAISE EXCEPTION 'STOP: public.billing_line_items.return_id is missing; 0089 shape not present';
  END IF;
  IF col.typ <> 'int4' THEN
    RAISE EXCEPTION 'STOP: return_id is %, expected int4', col.typ;
  END IF;
  IF col.notnull THEN
    RAISE EXCEPTION 'STOP: return_id is NOT NULL; 0089 created it nullable';
  END IF;
  IF col.hasdef OR col.generated <> '' THEN
    RAISE EXCEPTION 'STOP: return_id carries a default or generated expression';
  END IF;
END $$;
--> statement-breakpoint

-- Guard: refuse to build the unique index or validate the CHECK if the data would
-- violate them. Failing here with a clear reason beats a bare constraint error.
DO $$
DECLARE
  bad_type bigint;
  dupes bigint;
  orphans bigint;
BEGIN
  SELECT count(*) INTO bad_type
  FROM public.billing_line_items
  WHERE return_id IS NOT NULL
    AND line_type NOT IN ('return_postage', 'return_processing_fee');
  IF bad_type > 0 THEN
    RAISE EXCEPTION 'STOP: % row(s) attach return_id to a non-canonical line_type', bad_type;
  END IF;

  SELECT count(*) INTO dupes FROM (
    SELECT return_id, line_type
    FROM public.billing_line_items
    WHERE return_id IS NOT NULL
    GROUP BY return_id, line_type
    HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'STOP: % duplicate (return_id, line_type) group(s) exist', dupes;
  END IF;

  SELECT count(*) INTO orphans
  FROM public.billing_line_items b
  LEFT JOIN public.returns r ON r.id = b.return_id
  WHERE b.return_id IS NOT NULL AND r.id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'STOP: % row(s) reference a missing return', orphans;
  END IF;
END $$;
--> statement-breakpoint

-- The repair itself. DROP + ADD is the only way to change a FK's delete action;
-- both halves are inside this transaction, so the constraint is never missing in a
-- committed state.
ALTER TABLE "public"."billing_line_items"
  DROP CONSTRAINT IF EXISTS "billing_line_items_return_id_returns_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."billing_line_items"
  ADD CONSTRAINT "billing_line_items_return_id_returns_id_fk"
  FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- Preserved, not recreated: 0089's lookup index already serves "which billing rows
-- belong to this return". IF NOT EXISTS keeps this idempotent on a rerun.
CREATE INDEX IF NOT EXISTS "billing_li_return_id_idx"
  ON "public"."billing_line_items" ("return_id")
  WHERE "return_id" IS NOT NULL;
--> statement-breakpoint

-- At most one postage row and one processing row per return.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_li_return_identity_unq"
  ON "public"."billing_line_items" ("return_id", "line_type")
  WHERE "return_id" IS NOT NULL;
--> statement-breakpoint

-- A non-null return_id may only carry a canonical return type. Added NOT VALID then
-- validated separately so the validation scan takes a weaker lock than an inline
-- ADD CONSTRAINT would.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_li_return_id_canonical_type_check'
      AND conrelid = 'public.billing_line_items'::regclass
  ) THEN
    ALTER TABLE "public"."billing_line_items"
      ADD CONSTRAINT "billing_li_return_id_canonical_type_check"
      CHECK (
        "return_id" IS NULL
        OR "line_type" IN ('return_postage', 'return_processing_fee')
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "public"."billing_line_items"
  VALIDATE CONSTRAINT "billing_li_return_id_canonical_type_check";
