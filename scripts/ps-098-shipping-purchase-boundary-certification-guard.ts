import fs from 'node:fs';

import {
  assertSelectedRateProofForLabelPurchase,
  buildShippingRateRequestFingerprint,
  validateExactSelectedRate,
} from '../src/services/shipping-workflow/rate-fingerprint';

const checks: Array<[string, boolean]> = [];

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

function check(name: string, passed: boolean): void {
  checks.push([name, passed]);
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}`);
}

function indexAfter(source: string, needle: string, after = 0): number {
  const index = source.indexOf(needle, after);
  return index >= after ? index : -1;
}

function throwsSelectedRateProof(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === 'SELECTED_RATE_PROOF_INVALID');
  }
}

const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const packageRaw = read('package.json');
const directRates = read('api/carriers/rates.ts');
const directLabels = read('api/carriers/labels.ts');
const labelsRoute = read('src/routes/labels.ts');
const labelsService = read('src/services/labels.ts');
const printQueueService = read('src/services/print-queue.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
// PS-317: buildSelectedRateProofPayload moved to ./orders/best-rate/rate-proof.ts.
// The DEFINE check reads the new owner; the call-site census still scans OrdersView
// (call sites stayed) and is summed across both files so the count never undershoots.
const bestRateProof = read('web/src/components/Views/orders/best-rate/rate-proof.ts');
const proofWorkflow = read('src/services/shipping-workflow/rate-fingerprint.ts');
const ps084ReportExists = fs.existsSync('docs/ps-084-direct-carrier-print-queue-completion-report.md');

const requiredScripts = [
  'test:ps-079-best-rate-source-of-truth',
  'test:ps-081-rate-sync',
  'test:ps-083-direct-carrier-scope',
  'test:ps-084-direct-carrier-print-queue',
  'test:selected-rate-proof-boundary',
  'test:direct-carrier-labels',
  'test:direct-carrier-queue-route',
  'test:carriers-rates-hardening',
  'test:shipping-roundtrip-certification',
  'test:full-site-certification',
  'test:ps-098-shipping-purchase-boundary',
];

check(
  'package.json registers the aggregate safe purchase-boundary certification scripts',
  requiredScripts.every((name) => typeof packageJson.scripts?.[name] === 'string'),
);

const directRateScopeIndex = indexAfter(directRates, 'const scopeDecision = evaluateDirectCarrierScope');
const directRateProviderIndex = indexAfter(directRates, "if (provider === 'ups')", directRateScopeIndex);
check(
  'direct-carrier rate path enforces assignment scope before provider rate branches',
  directRateScopeIndex >= 0 && directRateProviderIndex > directRateScopeIndex,
);

// PS-209 re-anchor (2026-06-16): the standalone direct-carrier label owner
// (api/carriers/labels.ts) was RETIRED to a 410 stub; PS-202 unified direct-carrier
// purchases into createLabelV2 (src/services/labels.ts), whose single
// assertLabelPurchaseRateSelection gate precedes provider dispatch for ShipStation
// AND direct carriers (pinned in the ShipStation check below — the same gate covers
// direct). Direct-carrier ASSIGNMENT scope is owned by test:ps-083-direct-carrier-assignment-scope.
check(
  'legacy standalone direct-carrier label path is retired; direct purchases run through the unified proof-gated owner',
  /LEGACY_LABEL_ENDPOINT_RETIRED|cannot purchase postage/i.test(directLabels) &&
    indexAfter(labelsService, 'await assertLabelPurchaseRateSelection(') >= 0,
);

// PS-105 (Per user override unlock shipped data on 2026-06-06): the ShipStation
// boundary now enforces the selected-rate proof via the unified resolver
// assertLabelPurchaseRateSelection (prefers backend-owned rateQuoteId snapshot,
// falls back to carried selectedRateProof; delegates to the SAME strict validator).
// The invariant is unchanged: enforcement must precede the real postage connector call.
const shipStationProofIndex = indexAfter(labelsService, 'await assertLabelPurchaseRateSelection(');
const shipStationProviderIndex = indexAfter(labelsService, "createCarrierLabel('shipstation'", shipStationProofIndex);
check(
  'ShipStation label path checks selected-rate proof before real postage connector call',
  shipStationProofIndex >= 0 && shipStationProviderIndex > shipStationProofIndex,
);

check(
  'label route accepts proof input and returns safe selected-rate proof errors',
  labelsRoute.includes('selectedRateProof') &&
    labelsRoute.includes('z.unknown()') &&
    labelsRoute.includes("e.code === 'SELECTED_RATE_PROOF_INVALID'"),
);

// PS-317 A4 re-anchor (2026-06-24): the FRONTEND direct-carrier label BUY was DELETED.
// `createDirectCarrierLabelThenQueue` (which called apiClient.createLabel via the Vercel
// /carriers/labels path and carried its own `toRecord(overrideRecord?.selectedRateProof)
// ?? buildSelectedRateProofPayload(order, ...)` proof + account binding) no longer exists —
// every queue order now routes to the backend create/recover job and the backend owns ALL
// purchases. The proof/account-binding that the deleted FE buy used to carry was NOT lost:
// it is now sent as INTENT to the backend via buildQueueSendOrderPayload and ENFORCED at the
// backend purchase boundary (src/services/labels.ts createLabelV2). This check therefore (1)
// keeps the still-live FE intent-payload proof shapes, (2) asserts the FE direct-buy is GONE
// (anti-regression), and (3) RE-POINTS the deleted property to its new owners.
check(
  'frontend passes backend-issued selectedRateProof through label and queue intent payloads',
  // PS-317: DEFINE check re-pointed to the new owner best-rate/rate-proof.ts (positive test →
  // fails loud if the function is absent). The call-site census stays on OrdersView, but is
  // SUMMED across OrdersView + the new file so the count can never undershoot if a call site
  // ever moves too.
  bestRateProof.includes('function buildSelectedRateProofPayload') &&
    // The remaining FE proof flows: 2 INLINE property sites `selectedRateProof:
    // buildSelectedRateProofPayload(order, ...)` (the queue INTENT payload in
    // buildQueueSendOrderPayload + the panel single), and the BATCH-CREATE
    // `let selectedRateProof = buildSelectedRateProofPayload(order, proofRate, ...)`
    // with the PS-204 account-binding 3rd arg. (The deleted direct-buy override-wrapper
    // shape is asserted GONE below, not here.)
    ((ordersView + bestRateProof).match(/selectedRateProof: buildSelectedRateProofPayload\(order/g)?.length ?? 0) >= 2 &&
    ordersView.includes('let selectedRateProof = buildSelectedRateProofPayload(order, proofRate, orderIsTest ? null : shippingProviderId)') &&
    ordersView.includes('selectedRateProof,'),
);

// PS-317 A4 anti-regression: the frontend must BUY NOTHING for direct carriers. The deleted
// FE direct-buy function and its direct-carrier apiClient.createLabel override-wrapper (the
// `toRecord(overrideRecord?.selectedRateProof) ?? buildSelectedRateProofPayload(order, ...)`
// shape) must NOT reappear in OrdersView. If a future change reintroduces a FE direct-label
// purchase, this fails — re-routing the money path off the backend owner.
check(
  'frontend direct-carrier label BUY is removed (createDirectCarrierLabelThenQueue + its override-proof wrapper must not exist)',
  !ordersView.includes('createDirectCarrierLabelThenQueue') &&
    !/const selectedRateProof =\s*\n\s*toRecord\(overrideRecord\?\.selectedRateProof\) \?\?\s*\n\s*buildSelectedRateProofPayload\(order/.test(ordersView),
);

// PS-317 A4 relocation: the selected-rate proof + PS-204 account binding (shippingProviderId)
// + rate-quote ref that the deleted FE direct-buy carried is now sent to the backend as INTENT
// on the queue-send payload (buildQueueSendOrderPayload, ~line 3107), so the backend purchase
// owner receives exactly what the FE buy used to enforce locally.
check(
  'queue-send INTENT payload carries the proof + account binding + rate-quote ref the deleted FE buy used to carry',
  ordersView.includes('function buildQueueSendOrderPayload') &&
    ordersView.includes('selectedRateProof: buildSelectedRateProofPayload(order, bestRate ?? selectedRate, shippingProviderId)') &&
    ordersView.includes('shippingProviderId: shippingProviderId ?? undefined') &&
    /\.\.\.buildRateQuoteRefForOrder\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(ordersView),
);

// PS-317 A4 relocation (backend owner): the queue worker hands the FE intent label to the
// unified purchase owner createLabelV2, which (a) enforces the SAME selected-rate proof gate
// bound to the charged account BEFORE any provider call, and (b) detects + buys direct-carrier
// labels server-side (directLabelAccountRefFromProviderId → createDirectCarrierLabelForOrder).
// This is where the protection the deleted FE buy used to own now lives.
check(
  'backend owns the direct-carrier purchase: print-queue worker → createLabelV2 proof-gated direct buy',
  printQueueService.includes('createLabelV2(') &&
    labelsService.includes('purchaseShippingProviderId: body.shippingProviderId') &&
    indexAfter(
      labelsService,
      'const directRef = directLabelAccountRefFromProviderId(body.shippingProviderId);',
      indexAfter(labelsService, 'await assertLabelPurchaseRateSelection('),
    ) > 0 &&
    indexAfter(
      labelsService,
      'createDirectCarrierLabelForOrder({',
      indexAfter(labelsService, 'const directRef = directLabelAccountRefFromProviderId(body.shippingProviderId);'),
    ) > 0,
);

// PS-209 re-anchor (2026-06-16): direct-carrier print-to-queue local ship-to recovery is owned by its
// dedicated guard (test:ps-084-direct-carrier-print-queue) + report; the standalone api/ owner that
// once held resolveShipTo is retired (410 stub). Assert the dedicated coverage exists AND the legacy
// path is dead, rather than scanning the retired stub for a moved helper.
check(
  'direct-carrier print-to-queue local ship-to recovery remains certified (owned by its dedicated guard)',
  packageRaw.includes('"test:ps-084-direct-carrier-print-queue"') &&
    ps084ReportExists &&
    /LEGACY_LABEL_ENDPOINT_RETIRED|cannot purchase postage/i.test(directLabels),
);

const baseFingerprint = buildShippingRateRequestFingerprint({
  version: 'ps-098',
  shipDateBucket: '2026-06-05',
  weightOz: 16,
  toZip: '44114-1234',
  toCountry: 'US',
  toState: 'OH',
  toCity: 'Cleveland',
  residential: true,
  clientId: 101,
  storeId: 202,
  dimsL: 8,
  dimsW: 6,
  dimsH: 4,
  confirmation: 'delivery',
  insuranceProvider: 'carrier',
  insuredValue: 19.99,
  carrierIds: ['se-2', 'se-1'],
  automationRulesVersion: 'safe-static',
});
const changedFingerprint = buildShippingRateRequestFingerprint({
  version: 'ps-098',
  shipDateBucket: '2026-06-05',
  weightOz: 32,
  toZip: '44114-1234',
  toCountry: 'US',
  toState: 'OH',
  toCity: 'Cleveland',
  residential: true,
  clientId: 101,
  storeId: 202,
  dimsL: 8,
  dimsW: 6,
  dimsH: 4,
  confirmation: 'delivery',
  insuranceProvider: 'carrier',
  insuredValue: 19.99,
  carrierIds: ['se-2', 'se-1'],
  automationRulesVersion: 'safe-static',
});
check(
  'proof fingerprint changes when rate-affecting fields change and excludes full PII/secrets',
  baseFingerprint !== changedFingerprint &&
    !baseFingerprint.includes('Jane') &&
    !baseFingerprint.includes('Main St') &&
    !baseFingerprint.toLowerCase().includes('secret') &&
    !proofWorkflow.includes('rawLabel') &&
    !proofWorkflow.includes('apiSecret'),
);

const exactRate = {
  requestFingerprint: baseFingerprint,
  shippingProviderId: 'se-1',
  carrierCode: 'ups',
  serviceCode: 'ground',
  packageCode: 'package',
  shipmentCost: 7.25,
  otherCost: 0,
};
const alternateRate = {
  ...exactRate,
  serviceCode: 'next_day_air',
};
check(
  'exact selected-rate proof is accepted in offline validation',
  validateExactSelectedRate({
    currentRequestFingerprint: baseFingerprint,
    selectedRate: exactRate,
    eligibleRates: [exactRate],
  }).ok,
);

check(
  'missing, stale, and non-eligible selected-rate proofs are rejected before purchase',
  throwsSelectedRateProof(() => assertSelectedRateProofForLabelPurchase(null)) &&
    !validateExactSelectedRate({
      currentRequestFingerprint: changedFingerprint,
      selectedRate: exactRate,
      eligibleRates: [exactRate],
    }).ok &&
    !validateExactSelectedRate({
      currentRequestFingerprint: baseFingerprint,
      selectedRate: alternateRate,
      eligibleRates: [exactRate],
    }).ok,
);

const failures = checks.filter(([, passed]) => !passed);
if (failures.length) {
  console.error(`\nFAIL PS-098 shipping purchase-boundary certification (${failures.length} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-098 shipping purchase-boundary certification');
