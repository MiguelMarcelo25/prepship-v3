import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  normalizeOrderBestRateDto,
  normalizeOrderSelectedRateDto,
} from '../src/services/order-rate-dto';

function read(path: string): string {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

const labels = read('src/services/labels.ts');
const rates = read('src/services/rates.ts');
const ordersRoute = read('src/routes/orders.ts');
const shipmentsSchema = read('src/db/schema/shipments.ts');
const ordersSchema = read('src/db/schema/orders.ts');
const packageJson = JSON.parse(read('package.json')) as {
  scripts?: Record<string, string>;
};

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
  /carrierCode:\s*'ups'[\s\S]*?shippingProviderId:\s*565326/.test(ordersRoute) &&
    /carrierCode:\s*'ups'[\s\S]*?shippingProviderId:\s*607855/.test(ordersRoute),
  'Orders route carrier refs must preserve multiple UPS ShipStation accounts distinctly',
);

const accountA = normalizeOrderBestRateDto({
  carrier_id: 'se-565326',
  carrier_code: 'ups',
  carrier_nickname: 'GG6381',
  service_code: 'ups_ground',
  service_type: 'UPS Ground',
  shipping_amount: { amount: 10.25, currency: 'usd' },
});
const accountB = normalizeOrderBestRateDto({
  carrier_id: 'se-607855',
  carrier_code: 'ups',
  carrier_nickname: 'ROCEL C81F70',
  service_code: 'ups_ground',
  service_type: 'UPS Ground',
  shipping_amount: { amount: 11.5, currency: 'usd' },
});

assert(accountA, 'account A best-rate fixture should normalize');
assert(accountB, 'account B best-rate fixture should normalize');
assert.equal(accountA.shippingProviderId, 565326);
assert.equal(accountB.shippingProviderId, 607855);
assert.equal(accountA.carrierNickname, 'GG6381');
assert.equal(accountB.carrierNickname, 'ROCEL C81F70');
assert.notEqual(accountA.shippingProviderId, accountB.shippingProviderId);

const selectedA = normalizeOrderSelectedRateDto({
  providerAccountId: accountA.shippingProviderId,
  providerAccountNickname: accountA.carrierNickname,
  shippingProviderId: accountA.shippingProviderId,
  carrierCode: accountA.carrierCode,
  serviceCode: accountA.serviceCode,
  shipmentCost: accountA.shipmentCost,
});
const selectedB = normalizeOrderSelectedRateDto({
  providerAccountId: accountB.shippingProviderId,
  providerAccountNickname: accountB.carrierNickname,
  shippingProviderId: accountB.shippingProviderId,
  carrierCode: accountB.carrierCode,
  serviceCode: accountB.serviceCode,
  shipmentCost: accountB.shipmentCost,
});

assert(selectedA, 'account A selected-rate fixture should normalize');
assert(selectedB, 'account B selected-rate fixture should normalize');
assert.equal(selectedA.providerAccountId, 565326);
assert.equal(selectedB.providerAccountId, 607855);
assert.equal(selectedA.providerAccountNickname, 'GG6381');
assert.equal(selectedB.providerAccountNickname, 'ROCEL C81F70');

assert.equal(
  packageJson.scripts?.['test:shipstation-carrier-account-identity'],
  'tsx scripts/shipstation-carrier-account-identity-guard.ts',
  'package.json missing test:shipstation-carrier-account-identity script',
);

console.log('PASS ShipStation carrier account identity guard');
