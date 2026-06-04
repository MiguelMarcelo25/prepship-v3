/**
 * PS-085 Guard - backend shipping workflow fingerprint authority.
 *
 * Pure logic only: no DB, no provider calls, no labels, no postage, no
 * marketplace notifications, and no shipped/cancelled order mutations.
 *
 *   npx tsx scripts/ps-085-shipping-workflow-guard.ts
 */
import {
  buildShippingRateRequestFingerprint,
  selectedRateAuthorityKey,
  validateExactSelectedRate,
} from '../src/services/shipping-workflow/rate-fingerprint';

let failures = 0;

function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const baseRequest = {
  version: 'ps085-test',
  shipDateBucket: '2026-06-05',
  weightOz: 16,
  toZip: '90210-1234',
  toCountry: 'US',
  toState: 'CA',
  toCity: 'Beverly Hills',
  residential: true,
  clientId: 44,
  storeId: 376759,
  sourceClientId: 44,
  dimsL: 10,
  dimsW: 8,
  dimsH: 4,
  confirmation: 'signature',
  insuranceProvider: 'carrier',
  insuredValue: 100,
  carrierIds: ['se-222', 'se-111'],
  automationRulesVersion: 'rules-v7',
};

const fingerprint = buildShippingRateRequestFingerprint(baseRequest);
const sameCarrierSetFingerprint = buildShippingRateRequestFingerprint({
  ...baseRequest,
  carrierIds: ['se-111', 'se-222'],
});
const sameDimsDifferentWeightFingerprint = buildShippingRateRequestFingerprint({
  ...baseRequest,
  weightOz: 17,
});
const sameWeightDifferentScopeFingerprint = buildShippingRateRequestFingerprint({
  ...baseRequest,
  sourceClientId: 45,
});

check('fingerprint normalizes ZIP to five digits', fingerprint.includes('z=90210'));
check('fingerprint is stable for reordered carrier ids', fingerprint === sameCarrierSetFingerprint);
check('fingerprint changes when weight changes even if dimensions match', fingerprint !== sameDimsDifferentWeightFingerprint);
check('fingerprint changes when provider/client scope changes', fingerprint !== sameWeightDifferentScopeFingerprint);
check('fingerprint does not expose raw API keys', !fingerprint.includes('sk_live') && !fingerprint.includes('apiKey'));

const selected = {
  requestFingerprint: fingerprint,
  shippingProviderId: 111,
  carrierCode: 'ups',
  serviceCode: 'ups_ground',
  packageCode: 'package',
  shipmentCost: 8.12,
  otherCost: 0.31,
};
const eligible = [
  {
    carrier_id: 'se-111',
    carrier_code: 'ups',
    service_code: 'ups_ground',
    package_type: 'package',
    shipping_amount: { amount: 8.12 },
    other_amount: { amount: 0.31 },
  },
  {
    carrier_id: 'se-222',
    carrier_code: 'usps',
    service_code: 'usps_priority_mail',
    package_type: 'package',
    shipping_amount: { amount: 9.44 },
    other_amount: { amount: 0 },
  },
];

const accepted = validateExactSelectedRate({
  currentRequestFingerprint: fingerprint,
  selectedRate: selected,
  eligibleRates: eligible,
});
check('exact selected rate with current fingerprint is accepted', accepted.ok);
check('selected rate identity normalizes ShipStation provider ids', selectedRateAuthorityKey(selected) === selectedRateAuthorityKey(eligible[0]));

const stale = validateExactSelectedRate({
  currentRequestFingerprint: fingerprint,
  selectedRate: { ...selected, requestFingerprint: sameDimsDifferentWeightFingerprint },
  eligibleRates: eligible,
});
check('stale selected rate fingerprint is rejected', !stale.ok && stale.reason === 'fingerprint_mismatch');

const alternate = validateExactSelectedRate({
  currentRequestFingerprint: fingerprint,
  selectedRate: { ...selected, serviceCode: 'ups_2nd_day_air' },
  eligibleRates: eligible,
});
check('alternate selected rate not present in current eligible rates is rejected', !alternate.ok && alternate.reason === 'not_in_current_eligible_rates');

const missing = validateExactSelectedRate({
  currentRequestFingerprint: fingerprint,
  selectedRate: { ...selected, requestFingerprint: undefined },
  eligibleRates: eligible,
});
check('selected rate without request fingerprint is unresolved', !missing.ok && missing.reason === 'missing_fingerprint');

if (failures > 0) {
  console.error(`\nFAIL PS-085 shipping workflow guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-085 shipping workflow guard');
