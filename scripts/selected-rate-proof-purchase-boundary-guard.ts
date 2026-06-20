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
// assertLabelPurchaseRateSelection (prefers the backend-owned rateQuoteId snapshot,
// falls back to the carried selectedRateProof). The resolver delegates to the SAME
// strict validator (assertSelectedRateProofForLabelPurchase), so this is a refactor,
// not a weakening — the proof is still required before any real postage.
const proofResolver = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
check(
  'ShipStation label service enforces the selected-rate boundary before real postage',
  labelsService.includes('await assertLabelPurchaseRateSelection(') &&
    labelsService.includes('body.selectedRateProof') &&
    labelsService.includes('Per user override unlock shipped data on 2026-06-06') &&
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

check(
  'Orders single/batch/queue label payloads pass selectedRateProof',
  ordersView.includes('function buildSelectedRateProofPayload') &&
    // Each label payload sources its selectedRateProof from buildSelectedRateProofPayload.
    // The direct-carrier queue path additionally prefers a caller override
    // (overridePayload?.selectedRateProof ?? buildSelectedRateProofPayload(order, ...)),
    // so allow that wrapper form when counting the payload sites.
    //
    // PS-204 re-anchor (2026-06-12): the honest census of `selectedRateProof:`
    // property sites is THREE (panel single, direct-carrier override wrapper,
    // batch queue payload) — the fourth proof path is the batch-create flow's
    // `let selectedRateProof = buildSelectedRateProofPayload(...)` (pinned
    // below), which this property regex never matched. The old >= 4 was stale
    // since the PS-178 decomposition and failing silently outside the cert.
    // STRENGTHENED: the panel + batch property sites must now be ACCOUNT-BOUND
    // (third arg = the payload's shippingProviderId) per PS-204.
    (ordersView.match(/selectedRateProof:[\s\S]{0,160}?buildSelectedRateProofPayload\(order/g)?.length ?? 0) >= 2 &&
    /const selectedRateProof =[\s\S]{0,120}?buildSelectedRateProofPayload\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(ordersView) &&
    ordersView.includes('let selectedRateProof = buildSelectedRateProofPayload(order, proofRate, orderIsTest ? null : shippingProviderId)') &&
    /buildSelectedRateProofPayload\(order, panelRatePreview\[0\] \?\? order\.bestRate \?\? order\.selectedRate, isTest \? null : shippingProviderId\)/.test(ordersView) &&
    /buildSelectedRateProofPayload\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(ordersView),
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
