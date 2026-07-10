/**
 * PS-262c - Walmart Shipping exact store/account correlation guard.
 *
 * Offline only: no DB, provider, label, postage, marketplace, or production
 * mutation. A walmart_shipping carrier may rate or buy only for the exact
 * Walmart store_accounts row that owns the order, even when one client owns
 * multiple Walmart stores.
 */
import { readFileSync } from 'node:fs';
import {
  directCarrierAssignedToClient,
  directCarrierVisibleForScope,
  evaluateDirectCarrierScope,
  isStoreScopedShippingProvider,
} from '../src/lib/direct-carrier-scope';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const walmartCarrier = {
  provider: 'walmart_shipping',
  clientId: 42,
  assignedClientIds: [42],
  linkedStoreAccountId: 4201,
};
const exactOrderContext = {
  clientId: 42,
  storeId: 42,
  sourceProvider: 'walmart',
  sourceAccountId: '4201',
};

check('walmart_shipping is store-scoped', isStoreScopedShippingProvider('walmart_shipping'));
check('ebay_shipping is store-scoped', isStoreScopedShippingProvider('ebay_shipping'));
check('direct UPS is not store-scoped', !isStoreScopedShippingProvider('ups'));

check('rate allows the exact linked Walmart store account',
  directCarrierVisibleForScope(walmartCarrier, exactOrderContext));
check('rate blocks another Walmart store owned by the same client',
  !directCarrierVisibleForScope(walmartCarrier, {
    ...exactOrderContext,
    sourceAccountId: '4202',
  }));
check('rate blocks a different marketplace provider',
  !directCarrierVisibleForScope(walmartCarrier, {
    ...exactOrderContext,
    sourceProvider: 'ebay',
  }));
check('rate blocks a different client',
  !directCarrierVisibleForScope(walmartCarrier, {
    clientId: 99,
    storeId: 99,
    sourceProvider: 'walmart',
    sourceAccountId: '4201',
  }));
check('scopeless rate shopping keeps store-scoped carriers hidden',
  !directCarrierVisibleForScope(walmartCarrier, { includeAllDirectCarriers: true }));

check('client assignment still matches client 42',
  directCarrierAssignedToClient(walmartCarrier, 42));
check('client assignment still blocks client 99',
  !directCarrierAssignedToClient(walmartCarrier, 99));

check('label/rate scope gate allows the exact store account',
  evaluateDirectCarrierScope(walmartCarrier, { ...exactOrderContext, orderId: 5 }).allowed);
check('label/rate scope gate blocks the wrong store account',
  !evaluateDirectCarrierScope(walmartCarrier, {
    ...exactOrderContext,
    sourceAccountId: '4202',
    orderId: 5,
  }).allowed);

const ratesSource = readFileSync('src/services/rates.ts', 'utf8');
const labelsSource = readFileSync('src/services/labels-direct.ts', 'utf8');
const scopeSource = readFileSync('src/lib/direct-carrier-scope.ts', 'utf8');
const identitySource = readFileSync('src/services/carrier-account-identity.ts', 'utf8');

check('rate path applies directCarrierVisibleForScope',
  ratesSource.includes('directCarrierVisibleForScope'));
check('label path applies directCarrierVisibleForScope before purchase',
  labelsSource.includes('directCarrierVisibleForScope('));
check('label path blocks mismatched direct carrier identity',
  labelsSource.includes('DIRECT_CARRIER_NOT_ASSIGNED'));
check('identity owner maps walmart_shipping to Walmart stores',
  identitySource.includes("['walmart_shipping', 'walmart']"));
check('scope owner compares order sourceAccountId to linkedStoreAccountId',
  scopeSource.includes('sourceAccountId !== linkedStoreAccountId'));

if (failures > 0) {
  console.error(`\nFAIL PS-262c Walmart store-correlation guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-262c Walmart store-correlation guard');
