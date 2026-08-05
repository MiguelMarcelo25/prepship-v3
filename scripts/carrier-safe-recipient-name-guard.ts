import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveCarrierRecipientName } from '../src/services/carrier-recipient-name';

const unchanged = resolveCarrierRecipientName({
  name: 'Jose Alvarez',
  company: null,
  customerEmail: null,
});
assert.equal(unchanged.name, 'Jose Alvarez', 'ASCII recipient names should stay unchanged');
assert.equal(unchanged.source, 'name', 'ASCII recipient names should come from the recipient name');

const accented = resolveCarrierRecipientName({
  name: 'José Álvarez',
  company: null,
  customerEmail: null,
});
assert.equal(accented.name, 'Jose Alvarez', 'Latin accents should be stripped for carrier payloads');
assert.equal(accented.source, 'name', 'accent-stripped names should still be name-sourced');

const koreanWithEmail = resolveCarrierRecipientName({
  name: '유진 조',
  company: null,
  customerEmail: 'youjincho79@gmail.com',
});
assert.equal(koreanWithEmail.name, 'youjincho79', 'non-Latin names should fall back to email local-part');
assert.equal(koreanWithEmail.source, 'email', 'email fallback should be recorded');

const koreanWithoutFallback = resolveCarrierRecipientName({
  name: '유진 조',
  company: null,
  customerEmail: null,
});
assert.equal(koreanWithoutFallback.name, 'Customer', 'non-Latin names with no usable fallback should use Customer');
assert.equal(koreanWithoutFallback.source, 'fallback', 'Customer fallback should be recorded');

const companyFallback = resolveCarrierRecipientName({
  name: '유진 조',
  company: 'Blue Bell LLC',
  customerEmail: null,
});
assert.equal(companyFallback.name, 'Blue Bell LLC', 'safe company should be used before generic fallback');
assert.equal(companyFallback.source, 'company', 'company fallback should be recorded');

const unsafeCompany = resolveCarrierRecipientName({
  name: '유진 조',
  company: '회사',
  customerEmail: null,
});
assert.equal(unsafeCompany.company, undefined, 'unsafe company text should be omitted from carrier payloads');
assert.equal(unsafeCompany.name, 'Customer', 'unsafe company must not become the carrier recipient name');

const labels = readFileSync('src/services/labels.ts', 'utf8');
const shipp = readFileSync('src/connectors/carrier/shipp.ts', 'utf8');

assert.match(
  labels,
  /const carrierRecipient = resolveCarrierRecipientName\(\{[\s\S]*?customerEmail: order\.customerEmail/s,
  'createLabelV2 should resolve a carrier-safe recipient using the loaded order email',
);
// Repointed 2026-08-04: `const carrierShipTo` became `let`, because the payload
// is reassigned further down (labels.ts:2381 declares, :2475 reassigns). The
// binding keyword is not the property -- name and company still come from
// carrierRecipient, which is the whole point of this check.
assert.match(
  labels,
  /(?:const|let) carrierShipTo: ShipstationAddressInput = \{[\s\S]*?name: carrierRecipient\.name[\s\S]*?company: carrierRecipient\.company/s,
  'createLabelV2 should build a separate carrierShipTo payload',
);
assert.match(
  labels,
  /classifyShippingAddress\(\{[\s\S]*?name: shipTo\.name[\s\S]*?company: shipTo\.company/s,
  'residential classification should continue to use the original shipTo',
);
assert.match(
  labels,
  /shipTo: carrierShipTo,[\s\S]*?shippingOptions: options/s,
  'direct carrier purchases should receive carrierShipTo',
);
assert.match(
  labels,
  /shipTo: carrierShipTo,[\s\S]*?confirmation: options\.confirmation/s,
  'ShipStation purchases should receive carrierShipTo',
);
assert.match(
  shipp,
  /shippShipTo\([\s\S]*?input\.shipTo[\s\S]*?typeof input\.residential/s,
  'Shipp quote/label flow should prefer explicit sanitized input.shipTo over rawOrder ship-to',
);

console.log('PASS carrier-safe recipient name guard');
