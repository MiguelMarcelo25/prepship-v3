/**
 * PS-415 - carrier credential/store identity guard.
 *
 * Offline only: no DB, network, provider calls, labels, postage, marketplace
 * notifications, or production mutations.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  carrierStoreLinkIdentifier,
  isDirectShippingAccount,
  linkedStoreAccountIdFromIdentifier,
  resolveStoreAccountLink,
  safeCarrierAccountIdentifier,
  safeCarrierAccountLabel,
  storedCarrierAccountIdentifier,
  storeScopedCredentialsCorrelate,
  toSafeCarrierAccountReadModel,
  type StoreAccountIdentity,
} from '../src/services/carrier-account-identity';
import {
  directCarrierVisibleForScope,
  evaluateDirectCarrierScope,
} from '../src/lib/direct-carrier-scope';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const apiKey = 'secret-api-key-PS415-never-display';
const token = 'secret-refresh-token-PS415-never-display';

assert.equal(
  storedCarrierAccountIdentifier({
    provider: 'easypost',
    label: 'HUGRAB EasyPost',
    credentials: { apiKey },
  }),
  'HUGRAB EasyPost',
  'secret-only providers must use the operator label, not an API key',
);
assert.equal(
  safeCarrierAccountIdentifier({
    id: 7,
    provider: 'easypost',
    label: 'HUGRAB EasyPost',
    accountIdentifier: apiKey,
    credentials: { apiKey },
  }),
  'HUGRAB EasyPost',
);
assert.equal(
  storedCarrierAccountIdentifier({
    provider: 'ups',
    label: 'HUGRAB UPS',
    credentials: { accountNumber: 'UPS-ACCOUNT-42', apiKey },
  }),
  'UPS-ACCOUNT-42',
  'allowlisted non-secret account numbers remain usable identities',
);
assert.equal(
  safeCarrierAccountIdentifier({
    id: 9,
    provider: 'shopify',
    label: 'HUGRAB Shopify',
    accountIdentifier: null,
    credentials: { shopDomain: 'https://hugrab.myshopify.com/admin', accessToken: token },
  }),
  'hugrab.myshopify.com',
);
assert.equal(
  safeCarrierAccountLabel(
    { id: 7, provider: 'easypost', label: 'HUGRAB EasyPost', credentials: { apiKey } },
    `EasyPost ${apiKey}`,
  ),
  'HUGRAB EasyPost',
  'provider labels containing a secret must be replaced by the stored safe label',
);

assert.equal(carrierStoreLinkIdentifier(101), 'store:101');
assert.equal(linkedStoreAccountIdFromIdentifier('store:101'), 101);
assert.equal(linkedStoreAccountIdFromIdentifier(apiKey), null);
assert.equal(isDirectShippingAccount('walmart', 'store_accounts'), false);
assert.equal(isDirectShippingAccount('ebay', 'store_accounts'), false);
assert.equal(isDirectShippingAccount('walmart_shipping', 'store_accounts'), true);
assert.equal(isDirectShippingAccount('walmart_shipping', 'carrier_accounts'), true);

const walmartStore: StoreAccountIdentity = {
  id: 101,
  clientId: 42,
  provider: 'walmart',
  label: 'HUGRAB Walmart',
  accountIdentifier: 'seller-hugrab',
  credentials: { clientId: 'wm-client-hugrab', partnerId: 'partner-hugrab', clientSecret: token },
  active: true,
};
const secondMatchingWalmartStore: StoreAccountIdentity = {
  ...walmartStore,
  id: 102,
  label: 'HUGRAB Walmart backup',
};
const walmartCarrier = {
  id: 501,
  clientId: 42,
  provider: 'walmart_shipping',
  label: 'HUGRAB Walmart Shipping',
  accountIdentifier: 'store:101',
  credentials: { clientId: 'wm-client-hugrab', partnerId: 'partner-hugrab' },
  active: true,
};

assert.equal(
  storeScopedCredentialsCorrelate(
    'walmart_shipping',
    walmartCarrier.credentials,
    walmartStore.credentials,
  ),
  true,
);
assert.equal(
  storeScopedCredentialsCorrelate(
    'walmart_shipping',
    { ...walmartCarrier.credentials, clientId: 'another-client' },
    walmartStore.credentials,
  ),
  false,
);
assert.equal(
  storeScopedCredentialsCorrelate(
    'ebay_shipping',
    { appId: 'ebay-app', environment: 'production', refreshToken: token },
    { appId: 'ebay-app', environment: 'production', certId: 'cert' },
  ),
  true,
);
assert.equal(
  storeScopedCredentialsCorrelate(
    'ebay_shipping',
    { appId: 'ebay-app', environment: 'sandbox' },
    { appId: 'ebay-app', environment: 'production' },
  ),
  false,
);

const exactLink = resolveStoreAccountLink(walmartCarrier, [walmartStore, secondMatchingWalmartStore]);
assert.equal(exactLink.ok, true, 'explicit store:<id> must select only that correlated store row');
if (exactLink.ok) assert.equal(exactLink.store.id, 101);

const mismatchedExplicitLink = resolveStoreAccountLink(
  { ...walmartCarrier, accountIdentifier: 'store:999' },
  [walmartStore],
);
assert.deepEqual(mismatchedExplicitLink.ok, false);
if (!mismatchedExplicitLink.ok) assert.equal(mismatchedExplicitLink.code, 'STORE_LINK_MISMATCH');

const ambiguousLegacyLink = resolveStoreAccountLink(
  { ...walmartCarrier, accountIdentifier: null },
  [walmartStore, secondMatchingWalmartStore],
);
assert.deepEqual(ambiguousLegacyLink.ok, false);
if (!ambiguousLegacyLink.ok) assert.equal(ambiguousLegacyLink.code, 'STORE_LINK_AMBIGUOUS');

const missingLink = resolveStoreAccountLink(
  { ...walmartCarrier, accountIdentifier: null, credentials: { clientId: 'wrong' } },
  [walmartStore],
);
assert.deepEqual(missingLink.ok, false);
if (!missingLink.ok) assert.equal(missingLink.code, 'STORE_LINK_REQUIRED');

const safeReadModel = toSafeCarrierAccountReadModel(
  { ...walmartCarrier, credentials: { ...walmartCarrier.credentials, apiKey, refreshToken: token } },
  [walmartStore],
);
const serializedReadModel = JSON.stringify(safeReadModel);
assert.equal('credentials' in safeReadModel, false, 'Settings read DTO must omit credentials');
assert.equal(safeReadModel.linkedStoreAccountId, 101);
assert.equal(safeReadModel.displayIdentity, 'HUGRAB Walmart (#101)');
assert.equal(serializedReadModel.includes(apiKey), false);
assert.equal(serializedReadModel.includes(token), false);

const scopedCarrier = {
  ...walmartCarrier,
  assignedClientIds: [42],
  linkedStoreAccountId: 101,
};
const exactOrder = {
  clientId: 42,
  storeId: 9200014,
  sourceProvider: 'walmart',
  sourceAccountId: '101',
};
assert.equal(directCarrierVisibleForScope(scopedCarrier, exactOrder), true);
assert.equal(directCarrierVisibleForScope(scopedCarrier, { ...exactOrder, sourceAccountId: '102' }), false);
assert.equal(directCarrierVisibleForScope(scopedCarrier, { ...exactOrder, sourceProvider: 'ebay' }), false);
assert.equal(evaluateDirectCarrierScope(scopedCarrier, { ...exactOrder, orderId: 415 }).allowed, true);
assert.equal(
  evaluateDirectCarrierScope(scopedCarrier, { ...exactOrder, sourceAccountId: '102', orderId: 415 }).allowed,
  false,
);

const verification = read('src/connectors/carrier/credential-verification.ts');
const carrierHandler = read('src/lib/imported-handlers/carrier-accounts.ts');
const credentialAccounts = read('src/services/credential-accounts.ts');
const rateProducer = read('src/services/rate-browse-response-producer.ts');
const ratesRoute = read('src/routes/rates.ts');
const labelService = read('src/services/labels.ts');
const settings = read('web/src/components/Settings/CarrierIntegrationsCard.tsx');
const apiClient = read('web/src/lib/v2-apiClient.ts');
const sharedApiClient = read('web/src/lib/v2-apiClient/shared.ts');

assert.doesNotMatch(
  verification,
  /ORDER BY\s+(?:id|created_at)\s+DESC\s+LIMIT\s+1/i,
  'verification must never recover credentials from the newest active store row',
);
assert.match(verification, /credentialSource: 'exact_linked_store'/);
assert.match(verification, /resolveStoreAccountLink\(accountIdentity, storeRows\)/);
assert.match(verification, /accountIdentifier: safeCarrierAccountIdentifier\(identity\)/);

assert.match(carrierHandler, /requires the exact storeAccountId it belongs to/);
assert.match(carrierHandler, /accountIdentifier: carrierStoreLinkIdentifier\(requestedStoreAccountId\)/);
assert.match(carrierHandler, /resolveStoreAccountLink\(/);
assert.match(credentialAccounts, /return safeCredentialAccountRows\(sql, table, rows\)/);
assert.match(credentialAccounts, /export async function safeCredentialAccountRow\(/);
assert.match(credentialAccounts, /return safeCredentialAccountRow\(sql, table, rows\[0\] \?\? null\)/);

assert.match(rateProducer, /sourceAccountId: orderForBrowse\?\.sourceAccountId/);
assert.match(ratesRoute, /sourceAccountId: orders\.sourceAccountId/);
assert.match(ratesRoute, /orderId: z\.coerce\.number\(\)\.int\(\)\.positive\(\)/);
assert.match(ratesRoute, /orderScopePredicate\(scopeFromContext\(c\)\)/);
assert.match(labelService, /sourceAccountId: order\.sourceAccountId/);
assert.match(read('src/services/rates.ts'), /isDirectShippingAccount\(row\.provider, row\.sourceTable\)/);
assert.match(read('src/services/labels-direct.ts'), /DIRECT_CARRIER_ACCOUNT_NOT_SHIPPING/);

assert.match(settings, /storeAccountId: linkedStoreAccountId/);
assert.doesNotMatch(
  settings,
  /accountIdentifier:\s*formValues\.(?:apiKey|token|secret|clientId)/,
  'Settings must not derive account identity from credential fields',
);
assert.match(apiClient, /`\/rates\/carriers-for-store/);
assert.match(apiClient, /orderId: orderId \?\? undefined/);
assert.doesNotMatch(apiClient + sharedApiClient, /fetchDirectCarrierAccountRows|directCarrierAccountVisibleForOrder/);

console.log('PASS PS-415 carrier/store identity guard');
