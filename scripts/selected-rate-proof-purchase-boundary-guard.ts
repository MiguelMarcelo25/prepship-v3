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

check(
  'ShipStation label service enforces selectedRateProof before real postage',
  labelsService.includes('assertSelectedRateProofForLabelPurchase') &&
    labelsService.includes('body.selectedRateProof') &&
    labelsService.includes('Per user override unlock shipped data on 2026-06-05'),
);

check(
  'direct-carrier label function enforces selectedRateProof before carrier purchase',
  directLabels.includes('assertSelectedRateProofForLabelPurchase') &&
    directLabels.includes('body?.selectedRateProof') &&
    directLabels.includes('SELECTED_RATE_PROOF_INVALID'),
);

check(
  'Orders single/batch/queue label payloads pass selectedRateProof',
  ordersView.includes('function buildSelectedRateProofPayload') &&
    (ordersView.match(/selectedRateProof: buildSelectedRateProofPayload/g)?.length ?? 0) >= 4,
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
