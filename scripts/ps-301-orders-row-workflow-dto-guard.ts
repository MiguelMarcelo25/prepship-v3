/**
 * PS-301 guard — the NAMED OrdersView row-workflow DTO contract.
 *
 * Proves the backend BestRateWorkflowDto carries the card's named state axes
 * (lifecycleState / rateState / labelState / queueState / packageState), the named
 * allowedActions verbs (applyBestRate / printToQueue / editPackage / selectRow on top
 * of the PS-173 booleans), and a machine-readable blockedReasons map per disabled verb
 * — computed by the backend across awaiting / missing-dims / stale / pending /
 * existing-label / queued / shipped / cancelled / external-shipped rows.
 *
 * Also pins the ADDITIVE guarantee: a DTO built WITHOUT withOrderRowWorkflow carries
 * none of the named fields (legacy callers byte-identical).
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no marketplace
 * calls, no Trello mutation, no shipped/cancelled mutation.
 */
import {
  buildBestRateWorkflowDto,
  withOrderRowWorkflow,
  type BestRateWorkflowDto,
  type OrderRowWorkflowFacts,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const NOW = new Date('2026-06-22T12:00:00.000Z');
const FP = 'ps301|zip=19422|dims=8x6x6|provider=607855';

const freshRate = {
  amount: 10.79,
  shipmentCost: 10.79,
  otherCost: 0,
  serviceCode: 'ups_ground',
  carrierCode: 'ups',
  shippingProviderId: 607855,
  requestFingerprint: FP,
  cacheKey: FP,
  proofSource: 'backend_rate_response',
  isComplete: true,
  cacheExpiresAt: '2026-06-22T18:00:00.000Z',
};

const awaitingFacts: OrderRowWorkflowFacts = {
  orderStatus: 'awaiting_shipment',
  externallyShipped: false,
  canonicalStatus: null,
  isTest: false,
  hasCompleteDims: true,
  hasWeight: true,
  hasShipment: false,
  hasQueueableLabel: false,
  isDirectCarrierSelection: false,
  bestRateCarrierCode: 'ups',
  bestRateServiceCode: 'ups_ground',
  canonicalCarrierCode: null,
  canonicalServiceCode: null,
  canonicalAccountNickname: 'ROCEL C81F70',
  selectedRateCarrierCode: null,
  providerAccountId: 607855,
};

function dtoFor(savedBestRate: unknown, carrierStatus: 'cached' | 'loading' = 'cached'): BestRateWorkflowDto {
  return buildBestRateWorkflowDto({
    currentRequestFingerprint: FP,
    backendRequestKey: FP,
    savedBestRate,
    source: 'cache',
    carrierStatuses: [{ carrierId: 'se-607855', carrierName: 'UPS', status: carrierStatus, rateCount: 1 }],
    now: NOW,
  });
}

// 1. AWAITING + fresh proofed rate → final everywhere; all named verbs allowed; no blockedReasons.
const fresh = withOrderRowWorkflow(dtoFor(freshRate), awaitingFacts);
check('fresh: lifecycleState=awaiting', fresh.lifecycleState === 'awaiting', fresh.lifecycleState);
check('fresh: rateState=final', fresh.rateState === 'final', fresh.rateState);
check('fresh: queueState=can_queue', fresh.queueState === 'can_queue', fresh.queueState);
check('fresh: packageState=resolved', fresh.packageState === 'resolved', fresh.packageState);
check('fresh: labelState=none', fresh.labelState === 'none', fresh.labelState);
check('fresh: named verbs allowed',
  fresh.allowedActions.canApplyBestRate === true &&
  fresh.allowedActions.canPrintToQueue === true &&
  fresh.allowedActions.canEditPackage === true &&
  fresh.allowedActions.canSelectRow === true,
  fresh.allowedActions);
check('fresh: no blockedReasons', Object.keys(fresh.blockedReasons ?? {}).length === 0, fresh.blockedReasons);

// 2. MISSING DIMS → rateState/packageState=missing_dims/needs_dims; applyBestRate blocked w/ reason.
const noDims = withOrderRowWorkflow(dtoFor(freshRate), { ...awaitingFacts, hasCompleteDims: false });
check('missing-dims: rateState=missing_dims', noDims.rateState === 'missing_dims', noDims.rateState);
check('missing-dims: packageState=needs_dims', noDims.packageState === 'needs_dims', noDims.packageState);
check('missing-dims: applyBestRate blocked', noDims.allowedActions.canApplyBestRate === false, noDims.allowedActions);
check('missing-dims: createLabel blockedReason=missing_dims',
  noDims.blockedReasons?.createLabel === 'missing_dims', noDims.blockedReasons);

// 3. STALE (proven but expired) → rateState=expired; queueState=needs_current_rate; createLabel blocked.
const stale = withOrderRowWorkflow(dtoFor({ ...freshRate, cacheExpiresAt: '2026-06-22T11:59:59.000Z' }), awaitingFacts);
check('stale: rateState=expired', stale.rateState === 'expired', stale.rateState);
check('stale: queueState=needs_current_rate', stale.queueState === 'needs_current_rate', stale.queueState);
check('stale: createLabel blockedReason=needs_current_rate',
  stale.blockedReasons?.createLabel === 'needs_current_rate', stale.blockedReasons);

// 4. PENDING (PS-120 reader override applied before enrichment) → rateState=pending; queueState=needs_current_rate.
const pending = withOrderRowWorkflow({ ...dtoFor(freshRate), bestRateState: 'pending' }, awaitingFacts);
check('pending: rateState=pending', pending.rateState === 'pending', pending.rateState);
check('pending: queueState=needs_current_rate', pending.queueState === 'needs_current_rate', pending.queueState);

// 5. EXISTING ACTIVE LABEL on an awaiting row → labelState=active_label.
const withLabel = withOrderRowWorkflow(dtoFor(freshRate), { ...awaitingFacts, hasQueueableLabel: true });
check('active-label: labelState=active_label', withLabel.labelState === 'active_label', withLabel.labelState);

// 6. QUEUED label → labelState=queued; queueState=already_queued.
const queued = withOrderRowWorkflow(dtoFor(freshRate), { ...awaitingFacts, labelQueued: true });
check('queued: labelState=queued', queued.labelState === 'queued', queued.labelState);
check('queued: queueState=already_queued', queued.queueState === 'already_queued', queued.queueState);

// 7. SHIPPED (local) → lifecycleState=shipped; not selectable/editable (reinforces lock); queueState=recovery_available.
const shipped = withOrderRowWorkflow(dtoFor(freshRate), {
  ...awaitingFacts,
  orderStatus: 'shipped',
  hasShipment: true,
  hasLabelUrl: true,
});
check('shipped: lifecycleState=shipped', shipped.lifecycleState === 'shipped', shipped.lifecycleState);
check('shipped: labelState=active_label', shipped.labelState === 'active_label', shipped.labelState);
check('shipped: queueState=recovery_available', shipped.queueState === 'recovery_available', shipped.queueState);
check('shipped: NOT selectable/editable (lock reinforced)',
  shipped.allowedActions.canSelectRow === false && shipped.allowedActions.canEditPackage === false,
  shipped.allowedActions);
check('shipped: selectRow blockedReason=shipped_lock',
  shipped.blockedReasons?.selectRow === 'shipped_lock', shipped.blockedReasons);

// 8. SHIPPED but missing shipment sync → labelState=missing_label_url.
const shippedNoSync = withOrderRowWorkflow(dtoFor(freshRate), { ...awaitingFacts, orderStatus: 'shipped', hasShipment: false });
check('shipped-no-sync: labelState=missing_label_url', shippedNoSync.labelState === 'missing_label_url', shippedNoSync.labelState);

// 9. CANCELLED → lifecycleState=cancelled; rateState=blocked; everything blocked w/ cancelled_lock.
const cancelled = withOrderRowWorkflow(dtoFor(freshRate), { ...awaitingFacts, orderStatus: 'cancelled' });
check('cancelled: lifecycleState=cancelled', cancelled.lifecycleState === 'cancelled', cancelled.lifecycleState);
check('cancelled: rateState=blocked', cancelled.rateState === 'blocked', cancelled.rateState);
check('cancelled: queueState=blocked', cancelled.queueState === 'blocked', cancelled.queueState);
check('cancelled: selectRow blockedReason=cancelled_lock',
  cancelled.blockedReasons?.selectRow === 'cancelled_lock', cancelled.blockedReasons);

// 10. EXTERNAL SHIPPED → lifecycleState=external_shipped; selectRow blockedReason=external_shipped.
const external = withOrderRowWorkflow(dtoFor(freshRate), { ...awaitingFacts, externallyShipped: true });
check('external: lifecycleState=external_shipped', external.lifecycleState === 'external_shipped', external.lifecycleState);
check('external: selectRow blockedReason=external_shipped',
  external.blockedReasons?.selectRow === 'external_shipped', external.blockedReasons);

// 11. ADDITIVE GUARANTEE — a DTO built WITHOUT withOrderRowWorkflow carries none of the named fields.
const bare = dtoFor(freshRate);
check('additive: bare DTO has no lifecycleState', bare.lifecycleState === undefined);
check('additive: bare DTO has no rateState/labelState/queueState/packageState',
  bare.rateState === undefined &&
  bare.labelState === undefined &&
  bare.queueState === undefined &&
  bare.packageState === undefined);
check('additive: bare DTO has no blockedReasons', bare.blockedReasons === undefined);
check('additive: bare DTO has no named verbs',
  bare.allowedActions.canApplyBestRate === undefined &&
  bare.allowedActions.canSelectRow === undefined,
  bare.allowedActions);

if (failures > 0) {
  console.error(`\nPS-301 named-contract guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-301 named-contract guard passed.');
