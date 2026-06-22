/**
 * PS-300 guard - backend shipping authority gate.
 *
 * Locks the first backend-boundary migration rule for the active Lawrence PS
 * lane: a rate may be displayable while stale, but purchase/queue authority
 * must remain backend-proven and fresh. Offline only: no DB, no network, no
 * providers, no labels, no postage, no marketplace calls, no Trello mutation.
 */
import { readFileSync } from 'node:fs';
import {
  buildBestRateWorkflowDto,
  withOrderRowWorkflow,
  type OrderRowWorkflowFacts,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';
import {
  resolveRateQuoteForPurchase,
  selectedRateOpaqueKey,
  type RateQuoteSnapshot,
} from '../src/services/shipping-workflow/rate-quote-snapshot';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const NOW = new Date('2026-06-22T12:00:00.000Z');
const FINGERPRINT = 'rate:v1|zip=19422|dims=8x6x6|acct=607855';
const FRESH_EXPIRES = '2026-06-22T18:00:00.000Z';
const STALE_EXPIRES = '2026-06-22T11:59:59.000Z';

const provenRate = {
  amount: 10.79,
  shipmentCost: 10.79,
  otherCost: 0,
  serviceCode: 'ups_ground',
  carrierCode: 'ups',
  shippingProviderId: 607855,
  packageCode: 'package',
  requestFingerprint: FINGERPRINT,
  cacheKey: FINGERPRINT,
  proofSource: 'backend_rate_response',
  isComplete: true,
  cacheExpiresAt: FRESH_EXPIRES,
};

const staleProvenRate = {
  ...provenRate,
  cacheExpiresAt: STALE_EXPIRES,
};

const facts: OrderRowWorkflowFacts = {
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

const freshWorkflow = buildBestRateWorkflowDto({
  currentRequestFingerprint: FINGERPRINT,
  backendRequestKey: FINGERPRINT,
  savedBestRate: provenRate,
  source: 'cache',
  carrierStatuses: [{ carrierId: 'se-607855', carrierName: 'UPS', status: 'cached', rateCount: 1 }],
  now: NOW,
});

check('fresh backend-issued rate displays final amount',
  freshWorkflow.canDisplayFinalRate === true, freshWorkflow);
check('fresh backend-issued rate is purchase-usable',
  freshWorkflow.canUseDisplayedRateForPurchase === true &&
  freshWorkflow.allowedActions.canCreateLabel === true &&
  freshWorkflow.allowedActions.canUseSavedRate === true &&
  freshWorkflow.allowedActions.requiresRerate === false,
  freshWorkflow);

const staleWorkflow = buildBestRateWorkflowDto({
  currentRequestFingerprint: FINGERPRINT,
  backendRequestKey: FINGERPRINT,
  savedBestRate: staleProvenRate,
  source: 'cache',
  carrierStatuses: [{ carrierId: 'se-607855', carrierName: 'UPS', status: 'cached', rateCount: 1 }],
  now: NOW,
});

check('stale exact backend rate may still display',
  staleWorkflow.canDisplayFinalRate === true &&
  staleWorkflow.savedRateDisplay === 'stale',
  staleWorkflow);
check('stale exact backend rate cannot be used for purchase',
  staleWorkflow.canUseDisplayedRateForPurchase === false &&
  staleWorkflow.allowedActions.canCreateLabel === false &&
  staleWorkflow.allowedActions.canUseSavedRate === false &&
  staleWorkflow.allowedActions.requiresRerate === true,
  staleWorkflow);
check('row workflow keeps stale row rateable but blocks create/queue purchase',
  (() => {
    const enriched = withOrderRowWorkflow(staleWorkflow, facts);
    return enriched.rowState === 'stale_rate' &&
      enriched.allowedActions.canRate === true &&
      enriched.allowedActions.canCreateLabel === false &&
      enriched.allowedActions.canQueueLabel === false;
  })());

const unprovenWorkflow = buildBestRateWorkflowDto({
  currentRequestFingerprint: FINGERPRINT,
  backendRequestKey: FINGERPRINT,
  savedBestRate: {
    ...provenRate,
    proofSource: undefined,
  },
  source: 'cache',
  carrierStatuses: [{ carrierId: 'se-607855', carrierName: 'UPS', status: 'cached', rateCount: 1 }],
  now: NOW,
});

check('fresh-looking rate without backend proof cannot display as final',
  unprovenWorkflow.canDisplayFinalRate === false &&
  unprovenWorkflow.canUseDisplayedRateForPurchase === false &&
  unprovenWorkflow.allowedActions.canCreateLabel === false,
  unprovenWorkflow);

const incompleteWorkflow = buildBestRateWorkflowDto({
  currentRequestFingerprint: FINGERPRINT,
  backendRequestKey: FINGERPRINT,
  savedBestRate: provenRate,
  source: 'cache',
  carrierStatuses: [
    { carrierId: 'se-607855', carrierName: 'UPS', status: 'cached', rateCount: 1 },
    { carrierId: 'direct-shipp', carrierName: 'Shipp', status: 'loading', rateCount: 0 },
  ],
  now: NOW,
});

check('incomplete carrier coverage cannot emit a final/purchasable best rate',
  incompleteWorkflow.bestRateState === 'partial_carrier_failure' &&
  incompleteWorkflow.canDisplayFinalRate === false &&
  incompleteWorkflow.canUseDisplayedRateForPurchase === false,
  incompleteWorkflow);

const bestRate = { ...provenRate, serviceCode: 'ups_ground', shipmentCost: 10.79 };
const secondRate = { ...provenRate, serviceCode: 'ups_2day', shipmentCost: 14.25 };
const completeSnapshot: RateQuoteSnapshot = {
  cacheKey: FINGERPRINT,
  rates: [bestRate, secondRate],
  fetchedAt: NOW.toISOString(),
  bestRateKey: selectedRateOpaqueKey(bestRate),
  bestRateComplete: true,
};

check('backend snapshot resolves the finalized best rate for purchase',
  resolveRateQuoteForPurchase({
    snapshot: completeSnapshot,
    selectedRateKey: selectedRateOpaqueKey(bestRate),
    now: NOW.getTime(),
  }).ok === true);
check('backend snapshot rejects a selected rate that is not the finalized best',
  (() => {
    const result = resolveRateQuoteForPurchase({
      snapshot: completeSnapshot,
      selectedRateKey: selectedRateOpaqueKey(secondRate),
      now: NOW.getTime(),
    });
    return !result.ok && result.reason === 'selected_rate_not_best';
  })());
check('backend snapshot rejects a not-final rate universe',
  (() => {
    const result = resolveRateQuoteForPurchase({
      snapshot: { ...completeSnapshot, bestRateComplete: false },
      selectedRateKey: selectedRateOpaqueKey(bestRate),
      now: NOW.getTime(),
    });
    return !result.ok && result.reason === 'snapshot_not_final';
  })());

const labels = read('src/services/labels.ts');
const proofGateIndex = labels.indexOf('await assertLabelPurchaseRateSelection({');
const directBranchIndex = labels.indexOf('const directRef = directLabelAccountRefFromProviderId', proofGateIndex);
const directCreateIndex = labels.indexOf('createDirectCarrierLabelForOrder({', proofGateIndex);
const shipstationCreateIndex = labels.indexOf("timer.task('ShipStation createLabel connector'", proofGateIndex);

check('createLabelV2 runs selected-rate proof gate before choosing direct vs ShipStation provider',
  proofGateIndex > 0 &&
  directBranchIndex > proofGateIndex &&
  directCreateIndex > proofGateIndex &&
  shipstationCreateIndex > proofGateIndex);
check('createLabelV2 passes rateQuoteId, selectedRateKey, selectedRateProof, and purchase account to proof gate',
  /rateQuoteId:\s*body\.rateQuoteId/.test(labels) &&
  /selectedRateKey:\s*body\.selectedRateKey/.test(labels) &&
  /selectedRateProof:\s*body\.selectedRateProof/.test(labels) &&
  /purchaseShippingProviderId:\s*body\.shippingProviderId/.test(labels));

const rateStore = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
check('label purchase proof owner prefers backend snapshot id and key',
  /if \(body\.rateQuoteId && body\.selectedRateKey\)/.test(rateStore) &&
  /resolveRateQuoteForPurchase\(\{ snapshot, selectedRateKey: body\.selectedRateKey \}\)/.test(rateStore));
check('label purchase proof owner blocks not-final and not-best snapshots before fallback',
  /resolved\.reason === 'snapshot_not_final'/.test(rateStore) &&
  /resolved\.reason === 'selected_rate_not_best'/.test(rateStore) &&
  /throw new SelectedRateProofError/.test(rateStore));
check('strict proof mode can drop legacy fallback while canary mode remains explicit',
  /rateProofEnforcementMode\(\) === 'strict'/.test(rateStore) &&
  /FALL BACK to the legacy carried proof/.test(rateStore));

const printQueueRoute = read('src/routes/print-queue.ts');
check('print queue batch-send schema preserves selected-rate proof and backend snapshot ids',
  printQueueRoute.includes('selectedRateProof: z') &&
  printQueueRoute.includes('rateQuoteId: z.string().min(1).nullable().optional()') &&
  printQueueRoute.includes('selectedRateKey: z.string().min(1).nullable().optional()'));
check('print queue batch-send forwards proof and snapshot ids to the worker label payload',
  /selectedRateProof:\s*order\.label\.selectedRateProof/.test(printQueueRoute) &&
  /rateQuoteId:\s*order\.label\.rateQuoteId/.test(printQueueRoute) &&
  /selectedRateKey:\s*order\.label\.selectedRateKey/.test(printQueueRoute));

const printQueueService = read('src/services/print-queue.ts');
check('print queue worker uses createLabelV2 for missing labels, preserving label payload fields',
  /const created = await createLabelV2\(\{\s*\.\.\.order\.label/.test(printQueueService));

const workflowDoc = read('docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md');
check('workflow doc records PS-300 backend authority guard',
  workflowDoc.includes('test:ps-300-backend-shipping-authority'));

const packageJson = read('package.json');
check('package wires PS-300 backend authority guard',
  /"test:ps-300-backend-shipping-authority"\s*:\s*"tsx scripts\/ps-300-backend-shipping-authority-guard\.ts"/.test(packageJson));
check('package wires PS-290 insurance badge guard',
  /"test:ps-290-hugrab-insurance-coverage-badge"\s*:\s*"tsx scripts\/ps-290-hugrab-insurance-coverage-badge-guard\.ts"/.test(packageJson));

if (failures > 0) {
  console.error(`\nFAIL PS-300 backend shipping authority guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-300 backend shipping authority guard');
