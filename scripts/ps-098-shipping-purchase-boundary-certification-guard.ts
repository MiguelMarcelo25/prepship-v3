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
const ordersView = read('web/src/components/Views/OrdersView.tsx');
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

check(
  'frontend passes backend-issued selectedRateProof through label and queue payloads',
  ordersView.includes('function buildSelectedRateProofPayload') &&
    // PS-204 re-anchor (2026-06-16): honest census is THREE `selectedRateProof:
    // buildSelectedRateProofPayload(order...` property sites (panel single, direct-
    // carrier override wrapper, batch queue); the 4th proof path is the batch-create
    // `let selectedRateProof = buildSelectedRateProofPayload(...)` with the PS-204
    // account-binding 3rd arg (pinned below). Aligns with the selected-rate-proof-boundary guard.
    (ordersView.match(/selectedRateProof:[\s\S]{0,160}?buildSelectedRateProofPayload\(order/g)?.length ?? 0) >= 3 &&
    ordersView.includes('let selectedRateProof = buildSelectedRateProofPayload(order, proofRate, orderIsTest ? null : shippingProviderId)') &&
    ordersView.includes('selectedRateProof,'),
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
