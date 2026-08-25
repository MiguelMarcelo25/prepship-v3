-- 0105_ps497_claim_not_applicable_status.sql
--
-- PS-497 Slice 2 — replace 0090's quantity-state contract so a claim may terminate as
-- 'not_applicable' (external, non-deductible) with no quantity, and so a 'superseded' claim may retain
-- either a prior positive quantity or a never-executable NULL. Add an explicit status-domain CHECK that
-- includes 'not_applicable'. NO execution-capable state (pending/applied/reversed) may carry an unknown
-- quantity.
--
-- This migration DROPS 0090's fulfillment_line_claims_quantity_state_check — it is NOT purely additive.
-- The operator runner (scripts/apply-ps-497-claim-not-applicable-status.ts) is what applies it: it is
-- digest-pinned, pre-audits every status/quantity combination and STOPS on an unknown status (never
-- rewrites data), runs each statement standalone (so the brief AccessExclusive of an ADD CONSTRAINT is
-- released before the VALIDATE scan rather than held across it), and adds+validates BOTH successor
-- constraints BEFORE dropping 0090 — so the replacement protections are present the whole time.
--
-- Ordering (statement-per-step; the runner executes each separately with bounded timeouts):
--   1. ADD the replacement quantity-state constraint (v2) NOT VALID
--   2. ADD the status-domain constraint NOT VALID (this is what admits 'not_applicable')
--   3. VALIDATE v2
--   4. VALIDATE status-domain
--   5. DROP the old 0090 quantity-state check
--   6. DROP 0070's inline status CHECK (fulfillment_line_claims_status_check, which only allows the five
--      original statuses) LAST — the new status-domain check has already replaced it and is validated.
--
-- Every existing row already satisfies v2 (0090 only permitted NULL on review, which v2 still permits;
-- every non-review row already has a positive quantity) and the status-domain (0070 only ever allowed the
-- five statuses, all in the new domain), so both VALIDATE scans pass without change.

ALTER TABLE public.fulfillment_line_claims
  ADD CONSTRAINT fulfillment_line_claims_quantity_state_v2_check
  CHECK (
    (quantity IS NOT NULL AND quantity > 0)
    OR
    (quantity IS NULL AND status IN ('review', 'not_applicable', 'superseded'))
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fulfillment_line_claims
  ADD CONSTRAINT fulfillment_line_claims_status_domain_check
  CHECK (status IN ('pending', 'applied', 'superseded', 'reversed', 'review', 'not_applicable')) NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fulfillment_line_claims VALIDATE CONSTRAINT fulfillment_line_claims_quantity_state_v2_check;
--> statement-breakpoint
ALTER TABLE public.fulfillment_line_claims VALIDATE CONSTRAINT fulfillment_line_claims_status_domain_check;
--> statement-breakpoint
ALTER TABLE public.fulfillment_line_claims DROP CONSTRAINT fulfillment_line_claims_quantity_state_check;
--> statement-breakpoint
ALTER TABLE public.fulfillment_line_claims DROP CONSTRAINT fulfillment_line_claims_status_check;
