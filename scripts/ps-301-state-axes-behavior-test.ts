/**
 * PS-301 — REAL EXECUTION test for the named row state-axis derivers.
 *
 * ps-301-orders-row-workflow-dto-guard regexes the contract's shape; this test EXECUTES the
 * five pure derivers (lifecycle / rate / label / queue / package) and asserts the state machine
 * the whole named contract rests on: status-first precedence, shipped/cancelled rows resolving
 * to realized/closed states, and missing optional facts degrading to the SAFEST value. A
 * regression (e.g. a cancelled row reporting a live rate, or duplicate_risk losing to queued)
 * would pass the regex guard but fail here.
 *
 * Pure + deterministic (no I/O). Run: npm run test:ps-301-state-axes-behavior
 */
import {
  deriveOrderRowLifecycleState,
  deriveOrderRowRateState,
  deriveOrderRowLabelState,
  deriveOrderRowQueueState,
  deriveOrderRowPackageState,
} from '../src/services/shipping-workflow/order-row-state-axes';
import type { OrderRowWorkflowFacts } from '../src/services/shipping-workflow/best-rate-workflow-dto';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const BASE: OrderRowWorkflowFacts = {
  orderStatus: 'awaiting_shipment',
  externallyShipped: false,
  canonicalStatus: 'awaiting_shipment',
  isTest: false,
  hasCompleteDims: true,
  hasWeight: true,
  hasShipment: false,
  hasQueueableLabel: false,
  isDirectCarrierSelection: false,
  bestRateCarrierCode: null,
  bestRateServiceCode: null,
  canonicalCarrierCode: null,
  canonicalServiceCode: null,
  canonicalAccountNickname: null,
  selectedRateCarrierCode: null,
  providerAccountId: null,
};
const facts = (over: Partial<OrderRowWorkflowFacts>): OrderRowWorkflowFacts => ({ ...BASE, ...over });

// 1. Lifecycle — status-first precedence (cancelled > external_shipped > shipped > awaiting > blocked > unknown).
check('lifecycle: cancelled via orderStatus', deriveOrderRowLifecycleState(facts({ orderStatus: 'cancelled' })) === 'cancelled');
check('lifecycle: cancelled via canonicalStatus', deriveOrderRowLifecycleState(facts({ canonicalStatus: 'cancelled' })) === 'cancelled');
check('lifecycle: external_shipped', deriveOrderRowLifecycleState(facts({ externallyShipped: true })) === 'external_shipped');
check('lifecycle: shipped', deriveOrderRowLifecycleState(facts({ orderStatus: 'shipped' })) === 'shipped');
check('lifecycle: awaiting', deriveOrderRowLifecycleState(facts({})) === 'awaiting');
check('lifecycle: on_hold → blocked', deriveOrderRowLifecycleState(facts({ orderStatus: 'on_hold' })) === 'blocked');
check('lifecycle: unrecognized → unknown', deriveOrderRowLifecycleState(facts({ orderStatus: 'pending_payment' })) === 'unknown');
check('lifecycle: cancelled trumps external_shipped', deriveOrderRowLifecycleState(facts({ canonicalStatus: 'cancelled', externallyShipped: true })) === 'cancelled');

// 2. Rate — closed rows realized; else dims gate; else map the bestRateState.
check('rate: cancelled row → blocked regardless of rate', deriveOrderRowRateState(facts({ orderStatus: 'cancelled' }), 'fresh') === 'blocked');
check('rate: shipped row → final', deriveOrderRowRateState(facts({ orderStatus: 'shipped' }), 'missing') === 'final');
check('rate: external_shipped → final', deriveOrderRowRateState(facts({ externallyShipped: true }), 'missing') === 'final');
check('rate: incomplete dims → missing_dims', deriveOrderRowRateState(facts({ hasCompleteDims: false }), 'fresh') === 'missing_dims');
check('rate: fresh → final', deriveOrderRowRateState(facts({}), 'fresh') === 'final');
check('rate: pending/rating → pending',
  deriveOrderRowRateState(facts({}), 'pending') === 'pending' && deriveOrderRowRateState(facts({}), 'rating') === 'pending');
check('rate: stale → expired', deriveOrderRowRateState(facts({}), 'stale') === 'expired');
check('rate: missing → unavailable', deriveOrderRowRateState(facts({}), 'missing') === 'unavailable');
check('rate: blocked/partial_carrier_failure → blocked',
  deriveOrderRowRateState(facts({}), 'blocked') === 'blocked' && deriveOrderRowRateState(facts({}), 'partial_carrier_failure') === 'blocked');
check('rate: mismatched_request/unknown → stale',
  deriveOrderRowRateState(facts({}), 'mismatched_request') === 'stale' && deriveOrderRowRateState(facts({}), 'unknown') === 'stale');

// 3. Label — granular risk flags first; shipped rows need a real label URL.
check('label: duplicate_risk wins', deriveOrderRowLabelState(facts({ labelDuplicateRisk: true, labelQueued: true })) === 'duplicate_risk');
check('label: queued over printed', deriveOrderRowLabelState(facts({ labelQueued: true, labelPrinted: true })) === 'queued');
check('label: printed', deriveOrderRowLabelState(facts({ labelPrinted: true })) === 'printed');
check('label: shipped + no shipment → missing_label_url', deriveOrderRowLabelState(facts({ orderStatus: 'shipped', hasShipment: false })) === 'missing_label_url');
check('label: shipped + shipment + url → active_label', deriveOrderRowLabelState(facts({ orderStatus: 'shipped', hasShipment: true, hasLabelUrl: true })) === 'active_label');
check('label: shipped + url=false → missing_label_url', deriveOrderRowLabelState(facts({ orderStatus: 'shipped', hasShipment: true, hasLabelUrl: false })) === 'missing_label_url');
check('label: awaiting + queueable → active_label', deriveOrderRowLabelState(facts({ hasQueueableLabel: true })) === 'active_label');
check('label: awaiting, nothing → none', deriveOrderRowLabelState(facts({})) === 'none');

// 4. Queue — read-model eligibility (PS-303 owns real enforcement).
check('queue: cancelled → blocked', deriveOrderRowQueueState(facts({ orderStatus: 'cancelled' }), 'final') === 'blocked');
check('queue: already queued', deriveOrderRowQueueState(facts({ labelQueued: true }), 'final') === 'already_queued');
check('queue: local_shipped → recovery_available', deriveOrderRowQueueState(facts({}), 'local_shipped') === 'recovery_available');
check('queue: final → can_queue', deriveOrderRowQueueState(facts({}), 'final') === 'can_queue');
check('queue: needs_dims/stale_rate/missing_rate/pending → needs_current_rate',
  ['needs_dims', 'stale_rate', 'missing_rate', 'pending'].every((s) => deriveOrderRowQueueState(facts({}), s as 'final') === 'needs_current_rate'));
check('queue: other rowState → blocked', deriveOrderRowQueueState(facts({}), 'missing_shipment_sync') === 'blocked');

// 5. Package — stale impact first; dims gate; provenance.
check('package: stale impact wins', deriveOrderRowPackageState(facts({ packageStaleRateImpact: true })) === 'stale_rate_impact');
check('package: incomplete dims → needs_dims', deriveOrderRowPackageState(facts({ hasWeight: false })) === 'needs_dims');
check('package: default source → source', deriveOrderRowPackageState(facts({ packageSource: 'default' })) === 'source');
check('package: sku_default source → source', deriveOrderRowPackageState(facts({ packageSource: 'sku_default' })) === 'source');
check('package: complete + explicit source → resolved', deriveOrderRowPackageState(facts({ packageSource: 'manual' })) === 'resolved');

if (failures > 0) {
  console.error(`\nPS-301 state-axes behavior test FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-301 state-axes behavior test passed.');
