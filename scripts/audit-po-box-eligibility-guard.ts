import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyShippingAddress,
  isPoBoxAddress,
} from '../src/services/shipping-workflow/address-classification';
import { buildShippingRateRequestFingerprint } from '../src/services/shipping-workflow/rate-fingerprint';
import {
  PO_BOX_CARRIER_BLOCK_REASON,
  evaluateShippingServiceEligibility,
} from '../src/lib/shipping-service-eligibility';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

for (const street of [
  'PO Box 123',
  'P.O. Box 123',
  'P O BOX 123',
  'Post Office Box 123',
]) {
  assert.equal(isPoBoxAddress({ street1: street }), true, `${street} is a PO Box`);
}
assert.equal(isPoBoxAddress({ street1: '123 Main St', street2: 'PO Box 456' }), true);
for (const street of ['123 Boxwood Road', 'RR 2 Box 15', 'PMB 123', 'Box 99']) {
  assert.equal(isPoBoxAddress({ street1: street }), false, `${street} is not a PO Box`);
}

const classified = classifyShippingAddress({
  shipTo: { street1: 'P.O. Box 88', postalCode: '90210', country: 'US' },
});
assert.equal(classified.poBox, true, 'canonical address classification carries the PO Box axis');

const ups = { carrierCode: 'ups', serviceCode: 'ups_ground', serviceName: 'UPS Ground' };
const fedex = { carrierCode: 'fedex', serviceCode: 'fedex_ground', serviceName: 'FedEx Ground' };
const usps = { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', serviceName: 'USPS Ground Advantage' };
for (const service of [ups, fedex]) {
  const result = evaluateShippingServiceEligibility({ destinationPoBox: true }, service);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, PO_BOX_CARRIER_BLOCK_REASON);
  assert.equal(result.ruleId, 'po-box-carrier');
}
assert.equal(evaluateShippingServiceEligibility({ destinationPoBox: true }, usps).allowed, true);
assert.equal(evaluateShippingServiceEligibility({ destinationPoBox: false }, ups).allowed, true);
assert.equal(
  evaluateShippingServiceEligibility({ destinationPoBox: true }, { serviceCode: 'ups_ground' }).allowed,
  false,
  'service identity alone cannot bypass the final label guard',
);

const fingerprintInput = {
  version: 'audit-5.3',
  shipDateBucket: '2026-07-15',
  weightOz: 16,
  toZip: '90210',
  residential: true,
};
const poBoxFingerprint = buildShippingRateRequestFingerprint({
  ...fingerprintInput,
  destinationPoBox: true,
});
const streetFingerprint = buildShippingRateRequestFingerprint({
  ...fingerprintInput,
  destinationPoBox: false,
});
assert.notEqual(poBoxFingerprint, streetFingerprint, 'PO Box state must miss the rate cache');
assert.match(poBoxFingerprint, /\|pb=1(?:\||$)/);
assert.match(streetFingerprint, /\|pb=0(?:\||$)/);

const rates = read('src/services/rates.ts');
const backfill = read('src/services/rates-backfill.ts');
const browse = read('src/services/rate-browse-response-producer.ts');
const labels = read('src/services/labels.ts');
const ordersReadModel = read('src/services/orders-read-model.ts');
const doc = read('docs/ps-tickets/audit-5.3-po-box-eligibility.md');
const audit = read('AUDIT-2026-07-13.md');

assert.match(rates, /street1: input\.toAddress/);
assert.match(rates, /destinationPoBox: residentialClassification\.poBox/);
assert.match(rates, /destinationPoBox: input\.destinationPoBox/);
assert.match(backfill, /toAddress:.*backfillRawShipTo\.street1/);
assert.match(browse, /toAddress: rest\.toAddress \?\?/);
assert.match(ordersReadModel, /destinationPoBox:/);

const labelImpl = labels.slice(labels.indexOf('async function createLabelV2Impl'));
assert.ok(
  labelImpl.indexOf('const labelClassification = classifyShippingAddress')
    < labelImpl.indexOf('await assertLabelServiceEligibleForOrder'),
  'final label eligibility sees the canonical address classification before provider work',
);
assert.match(labels, /destinationPoBox,\s*\n/);
assert.match(labelImpl, /labelClassification\.poBox/);

for (const field of [
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
]) {
  assert.ok(doc.includes(field), `placement record includes ${field}`);
}
assert.match(
  audit,
  /- \[x\] 5\.3 \*\*PO Box eligibility axis in address-classification owner complete\*\*/,
  'canonical audit checklist marks 5.3 complete',
);

console.log('PASS Audit 5.3 PO Box eligibility guard');
