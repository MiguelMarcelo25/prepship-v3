-- 0104_ps497_fulfillment_occurrences.sql
--
-- PS-497 / PS-489 Slice 1 — a first-class physical-fulfillment identity.
--
-- Per user override unlock shipped data on 2026-08-25: this migration adds a new
-- public.fulfillment_occurrences relation and additive, nullable projection columns to the
-- order-lifecycle sidecars. It does NOT touch public.orders or public.shipments (no ALTER, no
-- column), it moves no row, and it changes no existing value. Every current claim row satisfies the
-- two new CHECKs trivially because occurrence_id is NULL on all of them. 0090's
-- fulfillment_line_claims_quantity_state_check is left exactly as it stands.
--
-- Every object is schema-qualified to public and the operator runner sets search_path = public, so
-- no check or DDL statement can be redirected by a caller's search_path to another schema's
-- same-named object.
--
-- Why this cannot 500 the running old app: every new column is nullable-with-no-default (a
-- metadata-only ALTER, no table rewrite); the two claim uniqueness indexes are PARTIAL on
-- occurrence_id IS NOT NULL, so they are INERT until a later slice populates occurrence_id; both
-- new CHECKs are added NOT VALID (they pass trivially) and VALIDATEd non-blocking. The Drizzle
-- mapping of these existing-table columns and the runtime-schema-readiness enrollment are
-- DELIBERATELY deferred to the production-apply step (see runtime-schema-readiness.ts:19-22 for the
-- same PS-502 discipline), so no bare select().from(fulfillment_line_claims) names a column before
-- this migration is applied.
--
-- This repo does NOT auto-apply by filename (the drizzle journal stops at 15). The operator lane
-- scripts/apply-ps-497-fulfillment-occurrences.ts is what runs it: it refuses to run unless the file
-- matches its pinned SHA-256, dry-runs by default, gates apply on --apply --confirm, pre-audits
-- reverse-claim duplicates before the global reversal index, verifies exact catalog definitions, and
-- asserts the claim table is byte-identical over the frozen pre-apply id range.
--
-- A sentinel line (further down) splits the file: everything above it is pure metadata-only DDL that
-- runs inside a single transaction; everything below uses CREATE INDEX CONCURRENTLY / VALIDATE,
-- which cannot run inside a transaction block.

-- >>> TRANSACTIONAL <<<

CREATE TABLE IF NOT EXISTS public.fulfillment_occurrences (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES public.orders(id),
  -- Option B (soft reference): NO foreign key to shipments, so this whole slice stays off the
  -- shipped/cancelled lockdown surface. fulfillment_occurrences_shipment_unq still makes the
  -- occurrence -> shipment relationship 1:1 without a REFERENCES clause.
  shipment_id integer,
  occurrence_key text NOT NULL,
  discriminator_kind text NOT NULL,
  first_seen_source text NOT NULL,
  superseded_by_occurrence_id integer REFERENCES public.fulfillment_occurrences(id),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_occurrences_kind_chk
    CHECK (discriminator_kind IN ('provider_shipment', 'local_shipment', 'whole_order'))
);
--> statement-breakpoint
-- Concurrent-creation single winner: two writers racing one deterministic occurrence_key
-- resolve-or-create via INSERT ... ON CONFLICT (occurrence_key) DO NOTHING, then SELECT the row.
CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_occurrences_key_unq
  ON public.fulfillment_occurrences (occurrence_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fulfillment_occurrences_order_idx
  ON public.fulfillment_occurrences (order_id, id);
--> statement-breakpoint
-- One occurrence per local shipment (partial, so shipment-less occurrences are unconstrained).
CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_occurrences_shipment_unq
  ON public.fulfillment_occurrences (shipment_id) WHERE shipment_id IS NOT NULL;
--> statement-breakpoint
-- Projection column on the append-only lifecycle event. Written only at row-insert time: the
-- append-only trigger blocks every later row rewrite, so historical events keep a NULL
-- occurrence_id forever (forward-only, by design).
ALTER TABLE public.order_lifecycle_events
  ADD COLUMN IF NOT EXISTS occurrence_id integer REFERENCES public.fulfillment_occurrences(id);
--> statement-breakpoint
ALTER TABLE public.fulfillment_line_claims
  ADD COLUMN IF NOT EXISTS occurrence_id integer REFERENCES public.fulfillment_occurrences(id);
--> statement-breakpoint
ALTER TABLE public.fulfillment_line_claims
  ADD COLUMN IF NOT EXISTS canonical_line_identity text;
--> statement-breakpoint
ALTER TABLE public.fulfillment_line_claims
  ADD COLUMN IF NOT EXISTS supply text;
--> statement-breakpoint
-- Per-line supply is the deduction authority for mixed-line fulfillment. Nullable (legacy rows
-- + later-slice flexibility); the value domain is fenced. Added NOT VALID then VALIDATEd so the
-- locked multi-million-row claim table is never scanned under AccessExclusive.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public'
      AND r.relname = 'fulfillment_line_claims'
      AND c.conname = 'fulfillment_line_claims_supply_chk'
  ) THEN
    ALTER TABLE public.fulfillment_line_claims
      ADD CONSTRAINT fulfillment_line_claims_supply_chk
      CHECK (supply IS NULL OR supply IN ('prepship', 'external', 'unknown')) NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint
-- Closes the NULL-identity double-deduct hole at the database: an occurrence-scoped claim MUST
-- carry a canonical_line_identity, so uniqueness key #1 can never treat two lines as distinct
-- for lack of an identity. Legacy rows (occurrence_id NULL) pass trivially.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public'
      AND r.relname = 'fulfillment_line_claims'
      AND c.conname = 'fulfillment_line_claims_occ_identity_present_chk'
  ) THEN
    ALTER TABLE public.fulfillment_line_claims
      ADD CONSTRAINT fulfillment_line_claims_occ_identity_present_chk
      CHECK (occurrence_id IS NULL OR canonical_line_identity IS NOT NULL) NOT VALID;
  END IF;
END
$$;

-- >>> NON-TRANSACTIONAL <<<

-- Hermes uniqueness key #1: inventory uniqueness = occurrence_id + canonical line identity +
-- direction. PARTIAL on occurrence_id, so every legacy claim (occurrence_id NULL) is excluded
-- and this index is INERT until a later slice sets occurrence_id. CONCURRENTLY keeps the build
-- off any AccessExclusive lock on the claim table.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_line_claims_occ_line_dir_unq
  ON public.fulfillment_line_claims (occurrence_id, canonical_line_identity, direction)
  WHERE occurrence_id IS NOT NULL;
--> statement-breakpoint
-- Hermes uniqueness key #2: reversal uniqueness = UNIQUE(original_claim_id) WHERE
-- direction='reverse'. GLOBAL over history, so the apply runner MUST pre-audit for existing
-- duplicates and ABORT before this index is built (it cannot create over a duplicate).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_line_claims_reverse_original_unq
  ON public.fulfillment_line_claims (original_claim_id)
  WHERE direction = 'reverse' AND original_claim_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.fulfillment_line_claims VALIDATE CONSTRAINT fulfillment_line_claims_supply_chk;
--> statement-breakpoint
ALTER TABLE public.fulfillment_line_claims VALIDATE CONSTRAINT fulfillment_line_claims_occ_identity_present_chk;
