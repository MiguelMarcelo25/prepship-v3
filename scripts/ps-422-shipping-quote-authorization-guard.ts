import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertShippingQuoteAccountMatches,
  assertShippingQuoteContextMatches,
  assertShippingQuoteIntentMatches,
  createShippingQuoteSelectionRef,
  parseShippingQuoteSelectionRef,
  shippingQuoteCredentialFingerprint,
  shippingQuoteSnapshotIdentityKey,
  type ShippingQuoteAccountAuthorization,
  type ShippingQuoteAuthorizationContext,
} from '../src/services/shipping-workflow/shipping-quote-authorization.js';

const context: ShippingQuoteAuthorizationContext = {
  version: 1,
  order: {
    orderId: 422,
    clientId: 12,
    storeId: 34,
    sourceProvider: 'walmart',
    sourceAccountId: '56',
    sourceOrderId: 'PO-422',
  },
  shipment: {
    shipFromLocationId: 7,
    shipFrom: {
      name: 'GWH',
      company: 'DR Prepper',
      street1: '100 Origin St',
      street2: '',
      city: 'Gardena',
      state: 'CA',
      postalCode: '90248',
      country: 'US',
      phone: '3105550100',
    },
    shipTo: {
      name: 'Buyer',
      company: '',
      street1: '200 Destination Ave',
      street2: 'Unit 4',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
      phone: '5125550100',
    },
    package: {
      id: 9,
      type: 'box',
      code: 'custom-9',
    },
    weightOz: 33,
    dimensions: { length: 9, width: 6, height: 3 },
    residential: true,
    confirmation: 'signature',
    insuranceProvider: 'parcelguard',
    insuredValue: 100,
  },
};

const account: ShippingQuoteAccountAuthorization = {
  providerFamily: 'direct',
  provider: 'walmart_shipping',
  shippingProviderId: 20_000_056,
  sourceTable: 'store_accounts',
  sourceAccountId: 56,
  ownerClientId: 12,
  ownerStoreAccountId: 56,
  credentialSource: 'store_account',
  credentialFingerprint: shippingQuoteCredentialFingerprint({ token: 'credential-422' }),
  environment: 'production',
};
const selectedRate = {
  shippingProviderId: account.shippingProviderId,
  carrierCode: 'walmart_shipping',
  serviceCode: 'ground',
  serviceName: 'Ground',
  packageCode: 'custom-9',
};
const purchaseIntent = {
  orderId: context.order.orderId,
  shippingProviderId: account.shippingProviderId,
  serviceCode: selectedRate.serviceCode,
  customPackageId: context.shipment.package.id,
  weightOz: context.shipment.weightOz,
  length: context.shipment.dimensions.length,
  width: context.shipment.dimensions.width,
  height: context.shipment.dimensions.height,
  confirmation: context.shipment.confirmation,
  insuranceProvider: context.shipment.insuranceProvider,
  insuredValue: context.shipment.insuredValue,
  shipFrom: context.shipment.shipFrom,
  shipTo: context.shipment.shipTo,
};

const rateQuoteId = 'rq_0123456789abcdef0123456789abcdef';
const selectedRateKey = 'srk_0123456789abcdef01234567';
const selectionRef = createShippingQuoteSelectionRef(rateQuoteId, selectedRateKey);
assert.ok(selectionRef.startsWith('sqa_'), 'selectionRef must be opaque and backend-namespaced');
assert.deepEqual(
  parseShippingQuoteSelectionRef(selectionRef),
  { rateQuoteId, selectedRateKey },
  'selectionRef must resolve only to the server-owned quote + selection keys',
);
assert.equal(parseShippingQuoteSelectionRef(`${selectionRef}tampered`), null, 'tampered refs must fail closed');
const authorization = { context, accounts: [account] };
const snapshotIdentity = shippingQuoteSnapshotIdentityKey({
  rateCacheKey: 'same-rate-cache-key',
  authorization,
  rates: [{ serviceCode: 'ground', amount: 9.42 }],
  fetchedAt: '2026-07-17T00:00:00.000Z',
});
assert.equal(
  snapshotIdentity,
  shippingQuoteSnapshotIdentityKey({
    rateCacheKey: 'same-rate-cache-key',
    authorization: structuredClone(authorization),
    rates: [{ serviceCode: 'ground', amount: 9.42 }],
    fetchedAt: '2026-07-17T00:00:00.000Z',
  }),
  'the exact same authorization must have a stable snapshot identity',
);
const otherOrderAuthorization = structuredClone(authorization);
otherOrderAuthorization.context.order.orderId = 423;
assert.notEqual(
  snapshotIdentity,
  shippingQuoteSnapshotIdentityKey({
    rateCacheKey: 'same-rate-cache-key',
    authorization: otherOrderAuthorization,
    rates: [{ serviceCode: 'ground', amount: 9.42 }],
    fetchedAt: '2026-07-17T00:00:00.000Z',
  }),
  'two orders with identical rate inputs must not overwrite one authorization snapshot',
);
const rotatedCredentialAuthorization = structuredClone(authorization);
rotatedCredentialAuthorization.accounts[0]!.credentialFingerprint =
  shippingQuoteCredentialFingerprint({ token: 'rotated' });
assert.notEqual(
  snapshotIdentity,
  shippingQuoteSnapshotIdentityKey({
    rateCacheKey: 'same-rate-cache-key',
    authorization: rotatedCredentialAuthorization,
    rates: [{ serviceCode: 'ground', amount: 9.42 }],
    fetchedAt: '2026-07-17T00:00:00.000Z',
  }),
  'credential rotation must mint a distinct immutable authorization snapshot',
);
assert.notEqual(
  snapshotIdentity,
  shippingQuoteSnapshotIdentityKey({
    rateCacheKey: 'same-rate-cache-key',
    authorization: structuredClone(authorization),
    rates: [{ serviceCode: 'ground', amount: 10.42 }],
    fetchedAt: '2026-07-17T00:00:00.000Z',
  }),
  'changed quote results must not overwrite an earlier authorization snapshot',
);

let providerCalls = 0;
function attemptPurchase(
  currentContext: ShippingQuoteAuthorizationContext,
  currentAccount: ShippingQuoteAccountAuthorization,
  intent = purchaseIntent,
): void {
  assertShippingQuoteContextMatches({ authorized: context, current: currentContext });
  assertShippingQuoteAccountMatches({ authorized: account, current: currentAccount });
  assertShippingQuoteIntentMatches({
    authorizationContext: context,
    accountAuthorization: account,
    selectedRate,
    intent,
  });
  providerCalls += 1;
}

attemptPurchase(structuredClone(context), structuredClone(account));
assert.equal(providerCalls, 1, 'an exact authorization should reach the provider once');

const contextMutations: Array<[string, (value: ShippingQuoteAuthorizationContext) => void]> = [
  ['order', (value) => { value.order.orderId = 423; }],
  ['client', (value) => { value.order.clientId = 99; }],
  ['store', (value) => { value.order.storeId = 99; }],
  ['source account', (value) => { value.order.sourceAccountId = 'other'; }],
  ['source order', (value) => { value.order.sourceOrderId = 'PO-other'; }],
  ['origin location', (value) => { value.shipment.shipFromLocationId = 8; }],
  ['origin street', (value) => { value.shipment.shipFrom.street1 = 'Changed origin'; }],
  ['destination street', (value) => { value.shipment.shipTo.street1 = 'Changed destination'; }],
  ['package id', (value) => { value.shipment.package.id = 10; }],
  ['package type', (value) => { value.shipment.package.type = 'envelope'; }],
  ['package code', (value) => { value.shipment.package.code = 'other'; }],
  ['weight', (value) => { value.shipment.weightOz = 34; }],
  ['length', (value) => { value.shipment.dimensions.length = 10; }],
  ['width', (value) => { value.shipment.dimensions.width = 7; }],
  ['height', (value) => { value.shipment.dimensions.height = 4; }],
  ['residential', (value) => { value.shipment.residential = false; }],
  ['confirmation', (value) => { value.shipment.confirmation = 'none'; }],
  ['insurance provider', (value) => { value.shipment.insuranceProvider = 'none'; }],
  ['insured value', (value) => { value.shipment.insuredValue = 0; }],
];

for (const [label, mutate] of contextMutations) {
  const changed = structuredClone(context);
  mutate(changed);
  assert.throws(
    () => attemptPurchase(changed, structuredClone(account)),
    /quote authorization/i,
    `${label} mismatch must block`,
  );
}

const accountMutations: Array<[string, (value: ShippingQuoteAccountAuthorization) => void]> = [
  ['provider family', (value) => { value.providerFamily = 'shipstation'; }],
  ['provider', (value) => { value.provider = 'shipstation'; }],
  ['numeric account', (value) => { value.shippingProviderId = 56; }],
  ['source table', (value) => { value.sourceTable = 'carrier_accounts'; }],
  ['source account row', (value) => { value.sourceAccountId = 57; }],
  ['missing source account row', (value) => { value.sourceAccountId = null; }],
  ['credential owner client', (value) => { value.ownerClientId = 98; }],
  ['credential owner store account', (value) => { value.ownerStoreAccountId = 98; }],
  ['credential source', (value) => { value.credentialSource = 'application_default'; }],
  ['credential version', (value) => { value.credentialFingerprint = 'different'; }],
  ['environment', (value) => { value.environment = 'test'; }],
  ['identity-less proof', (value) => { value.credentialFingerprint = ''; }],
];

for (const [label, mutate] of accountMutations) {
  const changed = structuredClone(account);
  mutate(changed);
  assert.throws(
    () => attemptPurchase(structuredClone(context), changed),
    /quote authorization/i,
    `${label} mismatch must block`,
  );
}

const intentMutations: Array<[string, (value: typeof purchaseIntent) => void]> = [
  ['requested order', (value) => { value.orderId = 423; }],
  ['requested carrier account', (value) => { value.shippingProviderId = 20_000_057; }],
  ['requested service', (value) => { value.serviceCode = 'express'; }],
  ['requested package', (value) => { value.customPackageId = 10; }],
  ['requested weight', (value) => { value.weightOz = 34; }],
  ['requested length', (value) => { value.length = 10; }],
  ['requested width', (value) => { value.width = 7; }],
  ['requested height', (value) => { value.height = 4; }],
  ['requested confirmation', (value) => { value.confirmation = 'none'; }],
  ['requested insurance provider', (value) => { value.insuranceProvider = 'none'; }],
  ['requested insured value', (value) => { value.insuredValue = 0; }],
  ['requested origin street', (value) => { value.shipFrom = { ...value.shipFrom, street1: 'Changed origin' }; }],
  ['requested destination street', (value) => { value.shipTo = { ...value.shipTo, street1: 'Changed destination' }; }],
];

for (const [label, mutate] of intentMutations) {
  const changed = structuredClone(purchaseIntent);
  mutate(changed);
  assert.throws(
    () => attemptPurchase(structuredClone(context), structuredClone(account), changed),
    /quote authorization/i,
    `${label} mismatch must block`,
  );
}

assert.equal(
  providerCalls,
  1,
  'every negative direct-label and Print Queue authorization case must stop before provider dispatch',
);

const snapshotStore = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
const labels = readFileSync('src/services/labels.ts', 'utf8');
const printQueue = readFileSync('src/services/print-queue.ts', 'utf8');
const queuePreflight = readFileSync('src/services/print-queue/queue-send-preflight.ts', 'utf8');
const labelRoute = readFileSync('src/routes/labels.ts', 'utf8');
const printQueueRoute = readFileSync('src/routes/print-queue.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const createLabelStart = labels.indexOf('async function createLabelV2Impl(');
const createLabelEnd = labels.indexOf('\nexport async function ', createLabelStart + 1);
const createLabelBody = labels.slice(createLabelStart, createLabelEnd);
const selectionIndex = createLabelBody.indexOf('await assertLabelPurchaseRateSelection({');
const contextIndex = createLabelBody.indexOf('assertShippingQuoteContextMatches({');
const directAccountIndex = createLabelBody.indexOf('assertShippingQuoteAccountMatches({');
const directProviderIndex = createLabelBody.indexOf('createDirectCarrierLabelForOrder({');
const secondAccountIndex = createLabelBody.indexOf(
  'assertShippingQuoteAccountMatches({',
  directAccountIndex + 1,
);
const shipStationOperationIndex = createLabelBody.indexOf(
  'const action = await acquireFulfillmentOperation({',
  directProviderIndex + 1,
);

assert.match(
  snapshotStore,
  /parseShippingQuoteSelectionRef\(body\.selectionRef\)[\s\S]*?authorization\?\.accounts\.find/,
  'the purchase resolver must resolve one selectionRef into a stored typed account authorization',
);
assert.match(
  createLabelBody,
  /shippingQuoteAuthorizedPurchaseFacts\(purchaseSelection\)[\s\S]*?assertShippingQuoteIntentMatches\(\{/,
  'provider facts must come from the authorization and request intent must match before dispatch',
);
assert.ok(
  selectionIndex >= 0
    && contextIndex > selectionIndex
    && directAccountIndex > contextIndex
    && directProviderIndex > directAccountIndex
    && secondAccountIndex > directProviderIndex
    && shipStationOperationIndex > secondAccountIndex,
  'context and current credential identity must be checked before direct or ShipStation dispatch',
);
assert.match(labelRoute, /selectionRef: z\.string\(\)\.min\(1\)/);
assert.match(printQueueRoute, /selectionRef: order\.label\.selectionRef/);
assert.match(
  queuePreflight,
  /selectionRef: carrierLabel\.selectionRef[\s\S]*?authorizationContext\.order[\s\S]*?order_scope_mismatch/,
  'Print Queue preflight must resolve the same authorization and enforce order/tenant identity',
);
assert.match(printQueue, /const labelPurchaseScope = queueWorkerClientStoreScope\(scope\)/);
assert.match(printQueue, /createLabelV2\(\{[\s\S]*?\}, labelPurchaseScope\)/);
assert.doesNotMatch(printQueue, /GLOBAL_SCOPE/);
assert.match(ordersView, /buildRateQuoteRefForOrder\(order, bestRate \?\? selectedRate, shippingProviderId\)/);
assert.doesNotMatch(
  ordersView,
  /selectedRateProof: buildSelectedRateProofPayload/,
  'the frontend must not carry reconstructable purchase proof into label or queue payloads',
);

console.log('PS-422 shipping quote authorization guard passed');
