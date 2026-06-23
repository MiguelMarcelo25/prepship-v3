// PS-301 — pure derivers for the named OrdersView row state axes. Each takes the
// already-computed row facts (+ the PS-173 rowState / base bestRateState the DTO
// owner already classified) and returns ONE display-safe axis. No I/O, no new
// heuristics beyond mapping the authoritative facts the route already provides;
// missing optional facts degrade to the safest value. Read-model only — these never
// authorize a purchase, mutate, or weaken the shipped/cancelled lock.
//
// RESERVED (QA audit 2026-06-23): the OPTIONAL granular facts — labelQueued, labelPrinted,
// labelDuplicateRisk, hasLabelUrl, packageSource, packageStaleRateImpact — are NOT yet supplied
// by the production caller (withOrderRowWorkflow in src/routes/orders.ts). Until a later phase
// wires them, the branches that read them (labelState 'queued'/'printed'/'duplicate_risk' and
// packageState 'source'/'stale_rate_impact') are exercised only by the unit tests
// (scripts/ps-301-state-axes-behavior-test.ts) and degrade safely at runtime to
// none/active_label/needs_dims/resolved. This is intentional, not a missing wire-up bug.

import type {
  OrderRowWorkflowFacts,
  OrderRowWorkflowState,
  BestRateWorkflowState,
} from './best-rate-workflow-dto';
import type {
  OrderRowLifecycleState,
  OrderRowRateState,
  OrderRowLabelState,
  OrderRowQueueState,
  OrderRowPackageState,
} from './order-row-states';

function needsDims(facts: OrderRowWorkflowFacts): boolean {
  return !facts.hasCompleteDims || !facts.hasWeight;
}

/** Order lifecycle (status-first; trumps any rate state). */
export function deriveOrderRowLifecycleState(facts: OrderRowWorkflowFacts): OrderRowLifecycleState {
  if (facts.orderStatus === 'cancelled' || facts.canonicalStatus === 'cancelled') return 'cancelled';
  if (facts.externallyShipped === true) return 'external_shipped';
  if (facts.orderStatus === 'shipped') return 'shipped';
  if (facts.orderStatus === 'awaiting_shipment') return 'awaiting';
  const status = (facts.orderStatus ?? '').toLowerCase();
  if (status.includes('hold') || status.includes('blocked')) return 'blocked';
  return 'unknown';
}

/** Rate lifecycle for the row. For shipped/cancelled rows the rate is realized/closed. */
export function deriveOrderRowRateState(
  facts: OrderRowWorkflowFacts,
  bestRateState: BestRateWorkflowState,
): OrderRowRateState {
  const lifecycle = deriveOrderRowLifecycleState(facts);
  if (lifecycle === 'cancelled') return 'blocked';
  if (lifecycle === 'shipped' || lifecycle === 'external_shipped') return 'final';
  if (needsDims(facts)) return 'missing_dims';
  switch (bestRateState) {
    case 'pending':
    case 'rating':
      return 'pending';
    case 'fresh':
      return 'final';
    case 'stale':
      return 'expired';
    case 'mismatched_request':
    case 'unknown':
      return 'stale';
    case 'blocked':
    case 'partial_carrier_failure':
      return 'blocked';
    case 'missing':
      return 'unavailable';
    default:
      return 'stale';
  }
}

/** Label state, conservative when granular label facts are absent (additive). */
export function deriveOrderRowLabelState(facts: OrderRowWorkflowFacts): OrderRowLabelState {
  if (facts.labelDuplicateRisk === true) return 'duplicate_risk';
  if (facts.labelQueued === true) return 'queued';
  if (facts.labelPrinted === true) return 'printed';
  const isShipped = facts.orderStatus === 'shipped';
  if (isShipped) {
    if (!facts.hasShipment || facts.hasLabelUrl === false) return 'missing_label_url';
    return 'active_label';
  }
  if (facts.hasQueueableLabel) return 'active_label';
  return 'none';
}

/** Queue eligibility (read-model only; PS-303 owns the actual queue/label enforcement). */
export function deriveOrderRowQueueState(
  facts: OrderRowWorkflowFacts,
  rowState: OrderRowWorkflowState,
): OrderRowQueueState {
  const lifecycle = deriveOrderRowLifecycleState(facts);
  if (lifecycle === 'cancelled') return 'blocked';
  if (facts.labelQueued === true) return 'already_queued';
  if (rowState === 'local_shipped') return 'recovery_available';
  if (rowState === 'final') return 'can_queue';
  if (rowState === 'needs_dims' || rowState === 'stale_rate' || rowState === 'missing_rate' || rowState === 'pending') {
    return 'needs_current_rate';
  }
  return 'blocked';
}

/** Package resolution status (sourced from dims/weight + optional package provenance facts). */
export function deriveOrderRowPackageState(facts: OrderRowWorkflowFacts): OrderRowPackageState {
  if (facts.packageStaleRateImpact === true) return 'stale_rate_impact';
  if (needsDims(facts)) return 'needs_dims';
  if (facts.packageSource === 'default' || facts.packageSource === 'sku_default') return 'source';
  return 'resolved';
}
