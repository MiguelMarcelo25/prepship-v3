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

// PS-105 (Per user override unlock shipped data on 2026-06-06): the direct-carrier
// boundary also enforces via the unified resolver (prefers rateQuoteId snapshot,
// falls back to carried selectedRateProof; delegates to the SAME strict validator).
check(
  'direct-carrier label function enforces the selected-rate boundary before carrier purchase',
  directLabels.includes('await assertLabelPurchaseRateSelection(') &&
    directLabels.includes('body?.selectedRateProof') &&
    directLabels.includes('SELECTED_RATE_PROOF_INVALID') &&
    proofResolver.includes('assertSelectedRateProofForLabelPurchase'),
);

check(
  'Orders single/batch/queue label payloads pass selectedRateProof',
  ordersView.includes('function buildSelectedRateProofPayload') &&
    // Each label payload sources its selectedRateProof from buildSelectedRateProofPayload.
    // The direct-carrier queue path additionally prefers a caller override
    // (overridePayload?.selectedRateProof ?? buildSelectedRateProofPayload(order, ...)),
    // so allow that wrapper form when counting the payload sites.
    (ordersView.match(/selectedRateProof:[\s\S]{0,160}?buildSelectedRateProofPayload\(order/g)?.length ?? 0) >= 4,
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
