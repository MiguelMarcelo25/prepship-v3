import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path) {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

const labels = read('src/services/labels.ts');
const rates = read('src/services/rates.ts');
const orderRateDto = read('src/services/order-rate-dto.ts');
const ordersRoute = read('src/routes/orders.ts');
const shipmentsSchema = read('src/db/schema/shipments.ts');
const ordersSchema = read('src/db/schema/orders.ts');
const packageJson = JSON.parse(read('package.json'));

for (const field of [
  'providerAccountId',
  'providerAccountNickname',
  'carrierProvider',
  'carrierAccountId',
  'labelProviderKey',
  'selectedRateJson',
]) {
  assert(shipmentsSchema.includes(`${field}:`), `shipments schema missing ${field}`);
}

assert(
  ordersSchema.includes('bestRateJson'),
  'order_overrides.bestRateJson must remain available for selected/best rate account identity',
);
assert(
  rates.includes('carrier_id') &&
    rates.includes('carrier_nickname') &&
    rates.includes('V2_CARRIER_ACCOUNT_OVERRIDES'),
  'rates service must preserve ShipStation carrier_id/provider account and nickname metadata',
);
assert(
  labels.includes("carrierProvider: 'shipstation'") &&
    labels.includes('carrierAccountId: created.providerAccountId') &&
    labels.includes('providerAccountNickname') &&
    labels.includes('selectedRateJson') &&
    labels.includes('shippingProviderId: created.providerAccountId'),
  'label persistence must freeze ShipStation carrier provider/account identity on shipments',
);
assert(
  orderRateDto.includes('providerAccountId') &&
    orderRateDto.includes('providerAccountNickname') &&
    orderRateDto.includes('shippingProviderId'),
  'order rate DTO normalization must preserve provider account id and nickname',
);
assert(
  /carrierCode:\s*'ups'[\s\S]*?shippingProviderId:\s*565326/.test(ordersRoute) &&
    /carrierCode:\s*'ups'[\s\S]*?shippingProviderId:\s*607855/.test(ordersRoute),
  'Orders route carrier refs must preserve multiple UPS ShipStation accounts distinctly',
);
assert.equal(
  packageJson.scripts?.['test:shipstation-carrier-account-identity'],
  'node scripts/shipstation-carrier-account-identity-guard.mjs',
  'package.json missing test:shipstation-carrier-account-identity script',
);

console.log('PASS ShipStation carrier account identity guard');
