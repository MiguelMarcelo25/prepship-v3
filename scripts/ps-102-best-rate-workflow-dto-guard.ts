/**
 * PS-102 Guard — backend Best Rate workflow DTO and Awaiting table consumption.
 *
 * Read-only: pure functions only. No DB, no carrier APIs, no labels, no queue.
 */
import {
  buildBestRateWorkflowDto,
  type BestRateWorkflowCarrierStatus,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';
import {
  classifyAwaitingRateCellState,
  classifyAwaitingRateCellStateWithWorkflow,
} from '../web/src/components/Views/orders-parity';

let failures = 0;

function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function checkDeep(name: string, predicate: boolean, detail: unknown) {
  if (!predicate) {
    failures += 1;
    console.error(`FAIL ${name}: ${JSON.stringify(detail)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const freshCarrierStatuses: BestRateWorkflowCarrierStatus[] = [
  { carrierId: 'se-ups', carrierName: 'UPS', status: 'live', rateCount: 3 },
  { carrierId: 'se-usps', carrierName: 'USPS', status: 'live', rateCount: 2 },
];

const staleCarrierStatuses: BestRateWorkflowCarrierStatus[] = [
  { carrierId: 'se-ups', carrierName: 'UPS', status: 'cached', rateCount: 2 },
];

const partialCarrierStatuses: BestRateWorkflowCarrierStatus[] = [
  { carrierId: 'se-ups', carrierName: 'UPS', status: 'live', rateCount: 2 },
  {
    carrierId: 'se-usps',
    carrierName: 'USPS',
    status: 'error',
    rateCount: 0,
    error: 'Raw token abc123 and long provider trace must not leak to the browser.'.repeat(6),
  },
];

const fresh = buildBestRateWorkflowDto({
  currentRequestFingerprint: 'rate:v4:current',
  savedBestRate: {
    amount: 7.25,
    serviceCode: 'ups_ground',
    carrierCode: 'ups',
    requestFingerprint: 'rate:v4:current',
    proofSource: 'backend_rate_response',
    cacheExpiresAt: '2026-06-05T12:10:00.000Z',
    isComplete: true,
  },
  source: 'live',
  carrierStatuses: freshCarrierStatuses,
  now: new Date('2026-06-05T12:00:00.000Z'),
});
check('fresh state', fresh.bestRateState, 'fresh');
check('fresh source confidence', fresh.sourceConfidence, 'live');
check('fresh can use saved rate', fresh.allowedActions.canUseSavedRate, true);
check('fresh does not require rerate', fresh.allowedActions.requiresRerate, false);
check('fresh can create label hint', fresh.allowedActions.canCreateLabel, true);
check('fresh backend request key', fresh.backendRequestKey, 'rate:v4:current');

const stale = buildBestRateWorkflowDto({
  currentRequestFingerprint: 'rate:v4:current',
  savedBestRate: {
    amount: 8.4,
    serviceCode: 'ups_ground',
    carrierCode: 'ups',
    requestFingerprint: 'rate:v4:current',
    proofSource: 'backend_rate_response',
    cacheExpiresAt: '2026-06-05T11:59:59.000Z',
    isComplete: true,
  },
  source: 'cache',
  carrierStatuses: staleCarrierStatuses,
  now: new Date('2026-06-05T12:00:00.000Z'),
});
check('stale state', stale.bestRateState, 'stale');
check('stale source confidence', stale.sourceConfidence, 'cache_stale');
check('stale requires rerate', stale.allowedActions.requiresRerate, true);
check('stale blocks create-label hint', stale.allowedActions.canCreateLabel, false);

const mismatched = buildBestRateWorkflowDto({
  currentRequestFingerprint: 'rate:v4:current',
  savedBestRate: {
    amount: 8.4,
    requestFingerprint: 'rate:v4:old',
    cacheExpiresAt: '2026-06-05T12:10:00.000Z',
    isComplete: true,
  },
  source: 'cache',
  carrierStatuses: staleCarrierStatuses,
  now: new Date('2026-06-05T12:00:00.000Z'),
});
check('mismatched state', mismatched.bestRateState, 'mismatched_request');
check('mismatched request fingerprint preserves backend current key', mismatched.requestFingerprint, 'rate:v4:current');
check('mismatched requires rerate', mismatched.allowedActions.requiresRerate, true);
check('mismatched blocks saved rate', mismatched.allowedActions.canUseSavedRate, false);

const partial = buildBestRateWorkflowDto({
  currentRequestFingerprint: 'rate:v4:current',
  savedBestRate: {
    amount: 7.25,
    requestFingerprint: 'rate:v4:current',
    cacheExpiresAt: '2026-06-05T12:10:00.000Z',
    isComplete: true,
  },
  source: 'live',
  carrierStatuses: partialCarrierStatuses,
  now: new Date('2026-06-05T12:00:00.000Z'),
});
check('partial state', partial.bestRateState, 'partial_carrier_failure');
check('partial source confidence', partial.sourceConfidence, 'partial');
check('partial does not present saved rate as fully usable', partial.allowedActions.canUseSavedRate, false);
check('partial requires rerate', partial.allowedActions.requiresRerate, true);
checkDeep(
  'carrier status errors are sanitized',
  Boolean(partial.carrierStatuses[1]?.error && partial.carrierStatuses[1].error.length <= 160),
  partial.carrierStatuses[1],
);

const missing = buildBestRateWorkflowDto({
  currentRequestFingerprint: 'rate:v4:current',
  savedBestRate: null,
  source: 'none',
  carrierStatuses: [],
  now: new Date('2026-06-05T12:00:00.000Z'),
});
check('missing state', missing.bestRateState, 'missing');
check('missing source confidence', missing.sourceConfidence, 'none');
check('missing requires rerate', missing.allowedActions.requiresRerate, true);
check('missing blocks create-label hint', missing.allowedActions.canCreateLabel, false);

const blocked = buildBestRateWorkflowDto({
  currentRequestFingerprint: 'rate:v4:current',
  savedBestRate: null,
  source: 'none',
  carrierStatuses: [
    { carrierId: 'se-ups', carrierName: 'UPS', status: 'error', rateCount: 0, error: 'carrier timeout' },
  ],
  now: new Date('2026-06-05T12:00:00.000Z'),
});
check('blocked state when carrier failure prevents any best rate', blocked.bestRateState, 'blocked');
check('blocked maps to error', classifyAwaitingRateCellStateWithWorkflow(blocked, {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
}), 'error');

const fallback = classifyAwaitingRateCellState({
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
});
const viaAbsentWorkflow = classifyAwaitingRateCellStateWithWorkflow(null, {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
});
check('absent workflow falls back to existing classifier', viaAbsentWorkflow, fallback);
// A backend-"fresh" rate only maps to 'ready' when the FRONTEND can actually
// display it. When the persisted rate fails the frontend freshness/proof
// contract (e.g. metadata stripped on persist, or right after a page reload
// before re-rating), the cell must show a loading spinner while it re-rates —
// NOT a "ready" cell that renders an empty rate (the "—" / blank Best Rate bug).
check('fresh + frontend-displayable maps to ready', classifyAwaitingRateCellStateWithWorkflow(fresh, {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: true,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
}), 'ready');
check('fresh without a PS-349 display verdict remains bounded pending', classifyAwaitingRateCellStateWithWorkflow(fresh, {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
}), 'pending');
check('partial workflow maps to error', classifyAwaitingRateCellStateWithWorkflow(partial, {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
}), 'error');
check('stale workflow maps to actionable stale', classifyAwaitingRateCellStateWithWorkflow(stale, {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
}), 'stale');
check('missing workflow maps to unavailable', classifyAwaitingRateCellStateWithWorkflow(missing, {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
}), 'unavailable');

if (failures > 0) {
  console.error(`\nFAIL PS-102 best-rate workflow DTO guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-102 best-rate workflow DTO guard');
