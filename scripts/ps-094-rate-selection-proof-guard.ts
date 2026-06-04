/**
 * PS-094 guard - backend selected-rate proof primitive compatibility.
 *
 * Static/pure only: no DB, no provider calls, no labels, no postage, and no
 * marketplace notifications.
 */
import {
  assertSelectedRateProofForLabelPurchase as canonicalAssert,
  buildShippingRateRequestFingerprint as canonicalFingerprint,
  selectedRateAuthorityKey as canonicalAuthorityKey,
  validateExactSelectedRate as canonicalValidate,
} from '../src/services/shipping-workflow/rate-fingerprint';
import {
  assertSelectedRateProofForLabelPurchase as aliasAssert,
  buildShippingRateRequestFingerprint as aliasFingerprint,
  selectedRateAuthorityKey as aliasAuthorityKey,
  validateExactSelectedRate as aliasValidate,
} from '../src/services/shipping-workflow/rate-selection-proof';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function proofError(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === 'SELECTED_RATE_PROOF_INVALID');
  }
}

check(
  'rate-selection-proof.ts re-exports the canonical backend proof authority without duplicate logic',
  aliasFingerprint === canonicalFingerprint &&
    aliasAuthorityKey === canonicalAuthorityKey &&
    aliasValidate === canonicalValidate &&
    aliasAssert === canonicalAssert,
);

const baseRequest = {
  version: 'ps-094',
  shipDateBucket: '2026-06-05',
  weightOz: 16,
  toZip: '44114-9999',
  toCountry: 'US',
  toState: 'OH',
  toCity: 'Cleveland',
  residential: false,
  clientId: 17,
  storeId: 71,
  dimsL: 9,
  dimsW: 6,
  dimsH: 3,
  confirmation: 'none',
  insuranceProvider: 'none',
  insuredValue: 0,
  carrierIds: ['se-111', 'se-222'],
  automationRulesVersion: 'ps-094-rules',
};

const fingerprint = aliasFingerprint(baseRequest);
check('fingerprint normalizes destination region without full street/name PII', fingerprint.includes('z=44114') && !fingerprint.includes('Jane') && !fingerprint.includes('Main'));
check('fingerprint does not expose secrets or raw labels', !/secret|api[_-]?key|token|rawLabel|labelUrl/i.test(fingerprint));
check('fingerprint changes when weight changes', fingerprint !== aliasFingerprint({ ...baseRequest, weightOz: 17 }));
check('fingerprint changes when dimensions change', fingerprint !== aliasFingerprint({ ...baseRequest, dimsL: 10 }));
check('fingerprint changes when confirmation changes', fingerprint !== aliasFingerprint({ ...baseRequest, confirmation: 'signature' }));
check('fingerprint changes when insurance changes', fingerprint !== aliasFingerprint({ ...baseRequest, insuranceProvider: 'carrier', insuredValue: 25 }));
check('fingerprint changes when eligible carrier scope changes', fingerprint !== aliasFingerprint({ ...baseRequest, carrierIds: ['se-111'] }));

const selectedRate = {
  requestFingerprint: fingerprint,
  shippingProviderId: 'se-111',
  carrierCode: 'ups',
  serviceCode: 'ground',
  packageCode: 'package',
  shipmentCost: 8.44,
  otherCost: 0,
};
const eligibleRate = {
  carrier_id: 'se-111',
  carrier_code: 'ups',
  service_code: 'ground',
  package_type: 'package',
  shipping_amount: { amount: 8.44 },
  other_amount: { amount: 0 },
};

check(
  'exact selected-rate proof is accepted',
  aliasValidate({
    currentRequestFingerprint: fingerprint,
    selectedRate,
    eligibleRates: [eligibleRate],
  }).ok,
);
check(
  'provider/service/package/cost authority changes when provider or service changes',
  aliasAuthorityKey(selectedRate) !== aliasAuthorityKey({ ...selectedRate, shippingProviderId: 'se-222' }) &&
    aliasAuthorityKey(selectedRate) !== aliasAuthorityKey({ ...selectedRate, serviceCode: 'air' }),
);
check(
  'stale or missing selected-rate proof rejects before purchase behavior can continue',
  proofError(() => aliasAssert(null)) &&
    !aliasValidate({
      currentRequestFingerprint: aliasFingerprint({ ...baseRequest, weightOz: 32 }),
      selectedRate,
      eligibleRates: [eligibleRate],
    }).ok,
);

if (failures > 0) {
  console.error(`\nFAIL PS-094 rate-selection-proof guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-094 rate-selection-proof guard');
