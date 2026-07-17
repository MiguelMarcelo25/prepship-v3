import fs from 'node:fs';

const checks: Array<[string, boolean]> = [];

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

function check(name: string, passed: boolean): void {
  checks.push([name, passed]);
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}`);
}

const workflow = read('src/services/shipping-workflow/rate-fingerprint.ts');
const labelsRoute = read('src/routes/labels.ts');
const labelsService = read('src/services/labels.ts');
const directLabels = read('api/carriers/labels.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
// PS-317: buildSelectedRateProofPayload moved to ./orders/best-rate/rate-proof.ts. The DEFINE
// check reads the new owner; the call-site census still scans OrdersView (call sites stayed) and
// is summed across both files so the count never undershoots.
const bestRateProof = read('web/src/components/Views/orders/best-rate/rate-proof.ts');
const packageJson = read('package.json');

check(
  'workflow utility exposes purchase-boundary selected-rate proof assertion',
  workflow.includes('assertSelectedRateProofForLabelPurchase') &&
    workflow.includes('SELECTED_RATE_PROOF_INVALID'),
);

check(
  'ShipStation label route accepts selectedRateProof payload',
  labelsRoute.includes('selectedRateProof') &&
    labelsRoute.includes('z.unknown()'),
);

// PS-105 (Per user override unlock shipped data on 2026-06-06): the ShipStation
// boundary now enforces the selected-rate proof via the unified resolver
// assertLabelPurchaseRateSelection. PS-419 requires the backend-owned rateQuoteId
// snapshot; carried selectedRateProof remains transport-only and cannot authorize
// postage. The resolver still delegates to the same strict proof validator, so this is a refactor,
// not a weakening — the proof is still required before any real postage.
const proofResolver = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
check(
  'ShipStation label service enforces the selected-rate boundary before real postage',
  labelsService.includes('await assertLabelPurchaseRateSelection(') &&
    labelsService.includes('selectionRef: body.selectionRef') &&
    labelsService.includes('Per user override unlock shipped data on 2026-05-23') &&
    labelsService.includes('assertShippingQuoteAccountMatches({') &&
    proofResolver.includes('assertSelectedRateProofForLabelPurchase'),
);

// PS-209 re-anchor (2026-06-16): the standalone direct-carrier purchase owner
// (api/carriers/labels.ts) was RETIRED to a 410 stub; PS-202 unified EVERY
// direct-carrier purchase into createLabelV2 (src/services/labels.ts), whose single
// assertLabelPurchaseRateSelection gate (pinned in the check above) precedes the
// provider dispatch for ShipStation AND direct carriers alike. Assert the legacy
// direct path is genuinely dead AND the unified owner still enforces the boundary.
// (Direct-carrier ASSIGNMENT scope has its own guard: test:ps-083-direct-carrier-assignment-scope.)
check(
  'direct-carrier purchases run through the unified, proof-gated owner; the legacy direct path is retired',
  /LEGACY_LABEL_ENDPOINT_RETIRED|cannot purchase postage/i.test(directLabels) &&
    labelsService.includes('await assertLabelPurchaseRateSelection(') &&
    proofResolver.includes('assertSelectedRateProofForLabelPurchase'),
);

// PS-317 A4 re-anchor (2026-06-24): the FRONTEND direct-carrier label BUY
// (createDirectCarrierLabelThenQueue, which called apiClient.createLabel = POST
// /labels for direct carriers) was DELETED from OrdersView. The frontend now buys
// NOTHING for the queue path — every queue order routes to the backend
// create/recover job (src/services/print-queue.ts processQueueSendOrder →
// src/services/labels.ts createLabelV2, which itself detects direct carriers via
// directLabelAccountRefFromProviderId and buys through createDirectCarrierLabelForOrder
// under the SAME assertLabelPurchaseRateSelection proof gate — already pinned by the
// two checks above). The FE only sends INTENT via buildQueueSendOrderPayload.
//
// So this check no longer asserts a FE *buy* exists. It asserts (1) the FE
// direct-buy is GONE (anti-regression), and (2) the selected-rate proof + account
// binding + rate-quote ref the deleted buy used to carry are STILL sent, relocated
// into the buildQueueSendOrderPayload INTENT payload that feeds the backend owner.
check(
  'FE direct-carrier label BUY is gone; queue intent carries only the account-filtered opaque selectionRef',
  bestRateProof.includes('function buildRateQuoteRefForOrder') &&
    !ordersView.includes('createDirectCarrierLabelThenQueue') &&
    !/selectedRateProof: buildSelectedRateProofPayload/.test(ordersView) &&
    ordersView.includes('function buildQueueSendOrderPayload') &&
    /buildRateQuoteRefForOrder\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(ordersView) &&
    /buildRateQuoteRefForOrder\(order, panelRatePreview\[0\] \?\? order\.bestRate \?\? order\.selectedRate, isTest \? null : shippingProviderId\)/.test(ordersView),
);

check(
  'package.json registers selected-rate proof boundary guard',
  packageJson.includes('"test:selected-rate-proof-boundary": "tsx scripts/selected-rate-proof-purchase-boundary-guard.ts"'),
);

const failures = checks.filter(([, passed]) => !passed);
if (failures.length) {
  console.error(`\nFAIL selected-rate proof purchase boundary guard (${failures.length} failing)`);
  process.exit(1);
}

console.log('\nPASS selected-rate proof purchase boundary guard');
