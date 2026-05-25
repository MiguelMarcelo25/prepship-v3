import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path) {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

const plan = read('docs/ps-031-store-connector-source-of-truth.md');
const normalized = read('src/services/normalized-order-persistence.ts');
const outbox = read('src/services/fulfillment/outbox.ts');
const fulfillmentTypes = read('src/domain/fulfillment/types.ts');
const packageJson = JSON.parse(read('package.json'));

for (const section of [
  '## Source-of-Truth Matrix',
  '## Mutation Ownership',
  '## ShipStation Compatibility',
  '## Non-ShipStation Connector Path',
  '## Carrier Account Differentiation',
  '## Safe Implementation Plan',
  '## Verification Plan',
]) {
  assert(plan.includes(section), `PS-031 plan missing ${section}`);
}

assert(
  normalized.includes('buildNormalizedOrderSource'),
  'normalized order persistence must expose provider-agnostic buildNormalizedOrderSource',
);
assert(
  normalized.includes('buildShipStationOrderSource') &&
    normalized.includes('return buildNormalizedOrderSource'),
  'ShipStation source helper must delegate to provider-agnostic source helper',
);
assert(
  outbox.includes("status: 'not_supported'"),
  'unsupported shipment confirmation providers must be marked not_supported, not not_required',
);
assert(
  !outbox.includes("const supported = provider === 'shipstation' || provider === 'walmart' || provider === 'ebay'"),
  'fulfillment outbox must not hardcode supported providers',
);
assert(
  outbox.includes("resolveStoreConnector(provider, 'shipment.confirm')"),
  'fulfillment outbox must resolve shipment confirmation through store connector capabilities',
);
assert(
  fulfillmentTypes.includes("'not_supported'"),
  'fulfillment confirmation status type must include not_supported',
);
assert.equal(
  packageJson.scripts?.['test:store-connector-source'],
  'node scripts/store-connector-source-guard.mjs',
  'package.json missing test:store-connector-source script',
);

console.log('PASS store connector source-of-truth guard');
