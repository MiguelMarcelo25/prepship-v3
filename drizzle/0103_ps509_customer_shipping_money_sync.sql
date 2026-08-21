-- PS-509 — durable customer-shipping-money outcomes for ShipStation sync ingress,
-- and the receipt-revised-after-freeze review class.
--
-- WHY THIS EXISTS
--
-- The frozen PS-509 contract (docs/ps-tickets/PS-509.md, accepted at 0020492e) requires
-- that EVERY sync-ingress eligibility evaluation persist a versioned, named outcome keyed
-- by shipment — so later config or attribution changes can never cause a consumer to
-- re-derive what happened at insertion from mutable state. It also requires a durable
-- review record for the one correction hazard the code trace identified: ShipStation
-- revising a receipt AFTER the customer money was frozen (measured base rate: 0 of 2,748
-- stamped rows in 90 days — rare, but a live divergence source once tuples exist).
--
-- Money is NOT stored here. The frozen customer-money tuple lives in
-- shipments.selected_rate_json under its policy-version key, exactly as PS-437/PS-508
-- wrote theirs. Outcomes carry classification, provenance and timing only, so a skip can
-- never smuggle a money fact past the version-keyed reader.
--
-- NO DATA IS TOUCHED. Additive CREATEs only: two tables, their indexes, and their
-- mutation guards. No INSERT, UPDATE, DELETE or backfill. Rollback of application code
-- does not require dropping these relations.

CREATE TABLE IF NOT EXISTS public.customer_shipping_money_sync_outcomes (
  id bigserial PRIMARY KEY,
  shipment_id integer NOT NULL REFERENCES public.shipments(id),
  -- Denormalized provider identity so audit joins survive shipment-row repair.
  label_shipment_id bigint,
  -- Which contract boundary produced the latest evaluation.
  boundary text NOT NULL,
  -- The durable named outcome. 'frozen' is terminal; the trigger below enforces that.
  outcome text NOT NULL,
  -- The eligibility contract that evaluated this shipment (versioned outcome).
  policy_contract text NOT NULL DEFAULT 'ps-509-v1',
  order_id integer,
  client_id integer,
  -- Failure classification when the outcome is needs_retry / needs_review
  -- (e.g. 'late_attributed' when a transactional link+freeze could not complete,
  -- 'malformed_known_version' / 'unknown_version' for review states).
  failure_classification text,
  detail text,
  evaluation_count integer NOT NULL DEFAULT 1,
  first_evaluated_at timestamptz NOT NULL DEFAULT now(),
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT csm_sync_outcomes_shipment_unq UNIQUE (shipment_id),
  CONSTRAINT csm_sync_outcomes_outcome_chk CHECK (outcome IN (
    'frozen',
    'no_order',
    'no_client',
    'billing_inactive',
    'no_billable_cost',
    'return',
    'voided',
    'test',
    'needs_retry',
    'needs_review'
  )),
  CONSTRAINT csm_sync_outcomes_boundary_chk CHECK (boundary IN (
    'sync_insert',
    'orphan_link',
    'retry_sweep'
  )),
  CONSTRAINT csm_sync_outcomes_policy_chk CHECK (policy_contract = 'ps-509-v1'),
  CONSTRAINT csm_sync_outcomes_eval_count_chk CHECK (evaluation_count >= 1)
);

CREATE INDEX IF NOT EXISTS csm_sync_outcomes_outcome_idx
  ON public.customer_shipping_money_sync_outcomes (outcome);

-- The retry sweep scans exactly these states, joined to shipments that have since
-- gained an order link; a partial index keeps the sweep cheap as outcomes accumulate.
CREATE INDEX IF NOT EXISTS csm_sync_outcomes_retryable_idx
  ON public.customer_shipping_money_sync_outcomes (shipment_id)
  WHERE outcome IN ('no_order', 'no_client', 'needs_retry');

-- 'frozen' is terminal: once a durable outcome says money was frozen, no later
-- evaluation may relabel it — the tuple itself is one-shot, and the outcome record
-- must not be able to disagree with it. Every other transition is legitimate
-- (no_order -> frozen is the ordinary late-attribution path). DELETE and TRUNCATE
-- are refused unconditionally: an outcome that can vanish cannot serve as the
-- durable record consumers read instead of re-deriving from mutable state.
CREATE OR REPLACE FUNCTION public.csm_sync_outcomes_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.outcome = 'frozen' AND NEW.outcome IS DISTINCT FROM 'frozen' THEN
      RAISE EXCEPTION 'customer_shipping_money_sync_outcomes: frozen is terminal (shipment %)', OLD.shipment_id;
    END IF;
    IF NEW.shipment_id IS DISTINCT FROM OLD.shipment_id THEN
      RAISE EXCEPTION 'customer_shipping_money_sync_outcomes: shipment identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'customer_shipping_money_sync_outcomes rows are durable: % is not allowed', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS csm_sync_outcomes_mutation_guard
  ON public.customer_shipping_money_sync_outcomes;
CREATE TRIGGER csm_sync_outcomes_mutation_guard
  BEFORE UPDATE OR DELETE ON public.customer_shipping_money_sync_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.csm_sync_outcomes_block_mutations();

DROP TRIGGER IF EXISTS csm_sync_outcomes_no_truncate
  ON public.customer_shipping_money_sync_outcomes;
CREATE TRIGGER csm_sync_outcomes_no_truncate
  BEFORE TRUNCATE ON public.customer_shipping_money_sync_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION public.csm_sync_outcomes_block_mutations();

-- ── receipt_revised_after_freeze ─────────────────────────────────────────────────────
--
-- ShipStation may revise a shipment's cost after ingestion. The sync UPDATE path writes
-- shipments.cost but (deliberately) never selected_rate_cost or the frozen tuple, so a
-- revision makes the carrier receipt and the frozen customer money disagree. Per the
-- accepted contract: the frozen money is NEVER auto-repriced and NEVER overwritten;
-- the disagreement becomes a durable, queryable review record with reconciliation state.
-- Unresolved post-watermark revisions block broad activation (PS-508 step 5+).

CREATE TABLE IF NOT EXISTS public.customer_shipping_money_receipt_revisions (
  id bigserial PRIMARY KEY,
  shipment_id integer NOT NULL REFERENCES public.shipments(id),
  review_class text NOT NULL DEFAULT 'receipt_revised_after_freeze',
  -- The policy version of the frozen tuple the receipt now disagrees with.
  policy_version text NOT NULL,
  previous_frozen_selected_cost numeric(12, 2) NOT NULL,
  current_postage_cost numeric(12, 2),
  current_other_cost numeric(12, 2),
  delta_signed numeric(12, 2) NOT NULL,
  delta_abs numeric(12, 2) NOT NULL,
  client_id integer,
  source text,
  reconciliation_state text NOT NULL DEFAULT 'open',
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,
  detection_count integer NOT NULL DEFAULT 1,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT csm_receipt_revisions_class_chk CHECK (review_class = 'receipt_revised_after_freeze'),
  CONSTRAINT csm_receipt_revisions_state_chk CHECK (reconciliation_state IN ('open', 'resolved')),
  CONSTRAINT csm_receipt_revisions_delta_abs_chk CHECK (delta_abs >= 0),
  CONSTRAINT csm_receipt_revisions_detections_chk CHECK (detection_count >= 1),
  CONSTRAINT csm_receipt_revisions_resolution_chk CHECK (
    (reconciliation_state = 'open' AND resolved_at IS NULL)
    OR (reconciliation_state = 'resolved' AND resolved_at IS NOT NULL)
  )
);

-- One OPEN revision per shipment: repeated sync passes update the open record
-- (detection_count, last_detected_at, current values) instead of accumulating rows.
-- Resolved records stay behind as history, so a second, later revision opens a new row.
CREATE UNIQUE INDEX IF NOT EXISTS csm_receipt_revisions_open_unq
  ON public.customer_shipping_money_receipt_revisions (shipment_id)
  WHERE reconciliation_state = 'open';

CREATE INDEX IF NOT EXISTS csm_receipt_revisions_shipment_idx
  ON public.customer_shipping_money_receipt_revisions (shipment_id);

CREATE INDEX IF NOT EXISTS csm_receipt_revisions_state_idx
  ON public.customer_shipping_money_receipt_revisions (reconciliation_state, first_detected_at);

-- Review evidence is durable: rows may be updated (re-detection, reconciliation) but
-- never deleted or truncated.
CREATE OR REPLACE FUNCTION public.csm_receipt_revisions_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.shipment_id IS DISTINCT FROM OLD.shipment_id
      OR NEW.previous_frozen_selected_cost IS DISTINCT FROM OLD.previous_frozen_selected_cost
      OR NEW.first_detected_at IS DISTINCT FROM OLD.first_detected_at THEN
      RAISE EXCEPTION 'customer_shipping_money_receipt_revisions: identity and first-detection evidence are immutable';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'customer_shipping_money_receipt_revisions rows are durable: % is not allowed', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS csm_receipt_revisions_mutation_guard
  ON public.customer_shipping_money_receipt_revisions;
CREATE TRIGGER csm_receipt_revisions_mutation_guard
  BEFORE UPDATE OR DELETE ON public.customer_shipping_money_receipt_revisions
  FOR EACH ROW EXECUTE FUNCTION public.csm_receipt_revisions_block_mutations();

DROP TRIGGER IF EXISTS csm_receipt_revisions_no_truncate
  ON public.customer_shipping_money_receipt_revisions;
CREATE TRIGGER csm_receipt_revisions_no_truncate
  BEFORE TRUNCATE ON public.customer_shipping_money_receipt_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.csm_receipt_revisions_block_mutations();
