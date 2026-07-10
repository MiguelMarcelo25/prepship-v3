/**
 * PS-326 guard - carrier/account identity certification over existing owners.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, and no production data mutation. This guard is a
 * certification matrix over the current backend identity owners; it must not
 * create a second provider/account identity implementation.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  directCarrierVisibleForScope,
  evaluateDirectCarrierScope,
  isStoreScopedShippingProvider,
  normalizeProviderKey,
} from '../src/lib/direct-carrier-scope';
import {
  normalizeCarrierProviderKey,
  resolveCarrierConnector,
} from '../src/connectors/carrier-resolution';
import {
  SelectedRateProofError,
  assertPurchaseAccountMatchesProof,
  selectedRateProviderAccountKey,
  validatePurchaseAccountBinding,
} from '../src/services/shipping-workflow/rate-fingerprint';
import {
  assertSsCarrierIdIsNotSynthetic,
  buildSsLabelRequestBody,
} from '../src/lib/shipstation/labels';
import {
  classifyQueueOrderRouteServer,
  planQueueRouteForOrders,
} from '../src/services/print-queue/queue-route-orchestrator';
import {
  normalizeOrderBestRateDto,
  normalizeOrderSelectedRateDto,
} from '../src/services/order-rate-dto';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function checkIncludesAll(name: string, text: string, values: string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

function checkPatterns(name: string, text: string, patterns: RegExp[]): void {
  const missing = patterns.map((pattern) => pattern.source).filter((_, index) => !patterns[index].test(text));
  check(name, missing.length === 0, missing);
}

const packageJson = read('package.json');
const ps326DocPath = 'docs/ps-tickets/ps-326-carrier-account-identity-certification.md';
const ps326Doc = read(ps326DocPath);

check('PS-326 certification doc exists', existsSync(ps326DocPath));
checkIncludesAll('PS-326 doc names the identity owner map and matrix coverage', ps326Doc, [
  'Carrier/account identity SOT owner map',
  'src/lib/direct-carrier-scope.ts',
  'src/connectors/carrier-resolution.ts',
  'src/services/shipping-workflow/rate-fingerprint.ts',
  'src/services/shipping-workflow/rate-quote-snapshot-store.ts',
  'src/lib/shipstation/labels.ts',
  'src/services/labels.ts#createLabelV2',
  'src/services/print-queue/queue-route-orchestrator.ts',
  'quote -> selected -> label -> queue -> shipment -> billing -> display',
  'ShipStation',
  'eBay Shipping',
  'Shipp brokered UPS',
  'EasyPost',
  'Walmart Shipping',
  'HUGRAB insurance-sensitive',
]);
checkIncludesAll('PS-326 doc records out-of-scope and safety limits', ps326Doc, [
  'Do not create a second provider identity service',
  'Do not redo PS-317 direct-carrier Print Queue cutover',
  'No real label purchases',
  'No raw credentials, API keys, raw labels, provider payloads, or customer PII',
]);

check('package wires PS-326 carrier/account identity certification guard',
  /"test:ps-326-carrier-account-identity-certification"\s*:\s*"tsx scripts\/ps-326-carrier-account-identity-certification-guard\.ts"/.test(packageJson));
for (const command of [
  'test:ps-083-direct-carrier-scope',
  'test:shipstation-carrier-account-identity',
  'test:ps-204-account-binding',
  'test:ps-216-rate-browser-account-labels',
  'test:ps-250-rates-scope-enforcement',
  'test:ps-303-print-queue-authority',
  'test:ps-317-fe-buy-anti-regression',
  'test:direct-carrier-queue-route',
]) {
  check(`package still wires predecessor identity guard ${command}`, packageJson.includes(`"${command}"`));
}

const directScope = read('src/lib/direct-carrier-scope.ts');
const carrierIdentity = read('src/services/carrier-account-identity.ts');
checkPatterns('direct-carrier scope owner keeps store/provider/account identity centralized', directScope, [
  /export function normalizeProviderKey/,
  /export function isStoreScopedShippingProvider/,
  /export function directCarrierVisibleForScope/,
  /export function evaluateDirectCarrierScope/,
]);
checkPatterns('carrier identity owner maps store-scoped shipping providers centrally', carrierIdentity, [
  /STORE_SCOPED_PROVIDER_MAP/,
  /\['walmart_shipping', 'walmart'\]/,
  /\['ebay_shipping', 'ebay'\]/,
  /export function resolveStoreAccountLink/,
]);
check('direct carrier scope behavior covers assignment and store-scoped providers',
  normalizeProviderKey('Walmart Shipping') === 'walmart_shipping' &&
  isStoreScopedShippingProvider('ebay-shipping') &&
  directCarrierVisibleForScope(
    { provider: 'shipp', assignedClientIds: [44] },
    { clientId: 44 },
  ) &&
  !directCarrierVisibleForScope(
    { provider: 'shipp', assignedClientIds: [44] },
    { clientId: 45 },
  ) &&
  !directCarrierVisibleForScope(
    { provider: 'walmart_shipping', assignedClientIds: [44], linkedStoreAccountId: 4401 },
    { includeAllDirectCarriers: true },
  ) &&
  directCarrierVisibleForScope(
    { provider: 'walmart_shipping', assignedClientIds: [44], linkedStoreAccountId: 4401 },
    { clientId: 44, sourceProvider: 'walmart', sourceAccountId: '4401' },
  ) &&
  !directCarrierVisibleForScope(
    { provider: 'walmart_shipping', assignedClientIds: [44], linkedStoreAccountId: 4401 },
    { clientId: 44, sourceProvider: 'walmart', sourceAccountId: '4402' },
  ) &&
  evaluateDirectCarrierScope({ assignedClientIds: [] }, { clientId: 44 }).allowed === false);

const carrierResolution = read('src/connectors/carrier-resolution.ts');
checkPatterns('carrier connector resolution owns provider aliases and capabilities', carrierResolution, [
  /export function normalizeCarrierProviderKey/,
  /export function resolveCarrierConnector/,
  /ebay_shipping/,
  /walmart_shipping/,
  /easypost/,
  /shipp/,
]);
check('carrier connector resolver normalizes covered provider families',
  normalizeCarrierProviderKey('easy_post') === 'easypost' &&
  normalizeCarrierProviderKey('WalmartShipping') === 'walmart_shipping' &&
  normalizeCarrierProviderKey('ebay_shipping') === 'ebay_shipping' &&
  resolveCarrierConnector('shipp')?.provider === 'shipp' &&
  resolveCarrierConnector('easypost')?.provider === 'easypost');

const rateFingerprint = read('src/services/shipping-workflow/rate-fingerprint.ts');
checkPatterns('selected-rate proof owner binds purchase account identity', rateFingerprint, [
  /export function selectedRateProviderAccountKey/,
  /export function validatePurchaseAccountBinding/,
  /export function assertPurchaseAccountMatchesProof/,
  /DIRECT_CARRIER_ON_SHIPSTATION_PATH/,
  /SELECTED_RATE_ACCOUNT_MISMATCH/,
]);
check('selected-rate proof behavior blocks synthetic direct id on ShipStation proof',
  (() => {
    const decision = validatePurchaseAccountBinding({
      purchaseShippingProviderId: 10_000_025,
      selectedRate: { carrier_id: 'se-565377', serviceCode: 'ups_ground' },
    });
    let thrown: unknown = null;
    try {
      assertPurchaseAccountMatchesProof({
        purchaseShippingProviderId: 10_000_025,
        selectedRate: { carrier_id: 'se-565377', serviceCode: 'ups_ground' },
      });
    } catch (err) {
      thrown = err;
    }
    return !decision.ok &&
      decision.reason === 'purchase_account_mismatch' &&
      thrown instanceof SelectedRateProofError &&
      thrown.code === 'DIRECT_CARRIER_ON_SHIPSTATION_PATH' &&
      selectedRateProviderAccountKey({ raw: { carrier_id: 'se-10000025' } }) === '10000025';
  })());

const quoteStore = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
check('rate quote snapshot store enforces account binding on the strict snapshot purchase path',
  (quoteStore.match(/assertPurchaseAccountMatchesProof\(\{/g) ?? []).length >= 1 &&
  quoteStore.includes('assertRateQuoteSnapshotForLabelPurchase') &&
  quoteStore.includes('purchaseShippingProviderId?: unknown'));

const ssLabels = read('src/lib/shipstation/labels.ts');
checkPatterns('ShipStation label builder rejects synthetic direct ids at the last mile', ssLabels, [
  /export function assertSsCarrierIdIsNotSynthetic/,
  /assertSsCarrierIdIsNotSynthetic\(input\.carrierId\);/,
  /DIRECT_CARRIER_ON_SHIPSTATION_PATH/,
]);
check('ShipStation label builder behavior rejects se-10000025 and accepts real se-* ids',
  (() => {
    let syntheticThrown: unknown = null;
    try {
      assertSsCarrierIdIsNotSynthetic('se-10000025');
    } catch (err) {
      syntheticThrown = err;
    }
    const input = {
      carrierId: 'se-565377',
      serviceCode: 'ups_ground',
      packageCode: 'package',
      weightOz: 16,
      length: 10,
      width: 8,
      height: 4,
      shipTo: { name: 'Recipient', street1: '1 Main', city: 'Oakland', state: 'CA', postalCode: '94601', country: 'US' },
      shipFrom: { name: 'PrepShip', street1: '2 Main', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US' },
      ssOrderId: null,
      orderNumber: 'PS-326-fixture',
    };
    const body = buildSsLabelRequestBody(input);
    return syntheticThrown instanceof Error &&
      (syntheticThrown as Error & { code?: string }).code === 'DIRECT_CARRIER_ON_SHIPSTATION_PATH' &&
      body.shipment.carrier_id === 'se-565377';
  })());

const labelsService = read('src/services/labels.ts');
checkPatterns('createLabelV2 consumes identity owners before provider purchase', labelsService, [
  /await assertLabelPurchaseRateSelection\(\{/,
  /purchaseShippingProviderId: body\.shippingProviderId/,
  /directLabelAccountRefFromProviderId\(body\.shippingProviderId\)/,
  /carrierProvider: 'shipstation'/,
  /carrierAccountId: created\.providerAccountId/,
  /providerAccountNickname/,
  /selectedRateJson/,
]);
check('label purchase proof gate runs before direct and ShipStation branches',
  (() => {
    const proofIndex = labelsService.indexOf('await assertLabelPurchaseRateSelection({');
    const directIndex = labelsService.indexOf('const directRef = directLabelAccountRefFromProviderId');
    const shipStationIndex = labelsService.indexOf('// Per user override unlock shipped data on 2026-06-06 (PS-106): carrier-family');
    return proofIndex >= 0 && directIndex > proofIndex && shipStationIndex > directIndex;
  })());

const queueOrchestrator = read('src/services/print-queue/queue-route-orchestrator.ts');
checkPatterns('Print Queue route orchestrator owns direct-vs-backend route identity', queueOrchestrator, [
  /export function classifyQueueOrderRouteServer/,
  /export function planQueueRouteForOrders/,
  /directViaBackend/,
  /explicitPayloadProviderId/,
]);
check('Print Queue route behavior prevents synthetic direct ids from falling through to FE/ShipStation path',
  classifyQueueOrderRouteServer({
    hasQueueableLabel: false,
    isTest: false,
    isDirectCarrier: false,
    backendQueueRoute: null,
    explicitPayloadProviderId: 10_000_025,
  }, { directViaBackend: true }) === 'backend' &&
  planQueueRouteForOrders([
    {
      orderId: 326,
      route: {
        hasQueueableLabel: false,
        isTest: false,
        isDirectCarrier: true,
        backendQueueRoute: null,
        explicitPayloadProviderId: 10_000_025,
      },
    },
  ], { directViaBackend: true }).directCreateOrderIds.length === 0);

const ordersView = read('web/src/components/Views/OrdersView.tsx');
const v2ApiClient = read('web/src/lib/v2-apiClient.ts');
check('frontend direct-carrier purchase orchestration remains removed',
  !ordersView.includes('createDirectCarrierLabelThenQueue') &&
  !/createDirectCarrierLabel(ThenQueue|ForOrder)?\s*\(/.test(ordersView));
check('frontend createLabel remains an intent POST to backend labels route',
  /api\.post<[^>]*>\(\s*['"]\/labels['"]/.test(v2ApiClient) ||
  /api\.post\(\s*['"]\/labels['"]/.test(v2ApiClient));

const rateA = normalizeOrderBestRateDto({
  carrier_id: 'se-565326',
  carrier_code: 'ups',
  carrier_nickname: 'GG6381',
  service_code: 'ups_ground',
  service_type: 'UPS Ground',
  shipping_amount: { amount: 10.25, currency: 'usd' },
});
const rateB = normalizeOrderBestRateDto({
  carrier_id: 'se-607855',
  carrier_code: 'ups',
  carrier_nickname: 'ROCEL C81F70',
  service_code: 'ups_ground',
  service_type: 'UPS Ground',
  shipping_amount: { amount: 11.5, currency: 'usd' },
});
const selectedA = normalizeOrderSelectedRateDto({
  providerAccountId: rateA?.shippingProviderId,
  providerAccountNickname: rateA?.carrierNickname,
  shippingProviderId: rateA?.shippingProviderId,
  carrierCode: rateA?.carrierCode,
  serviceCode: rateA?.serviceCode,
  shipmentCost: rateA?.shipmentCost,
});
const selectedB = normalizeOrderSelectedRateDto({
  providerAccountId: rateB?.shippingProviderId,
  providerAccountNickname: rateB?.carrierNickname,
  shippingProviderId: rateB?.shippingProviderId,
  carrierCode: rateB?.carrierCode,
  serviceCode: rateB?.serviceCode,
  shipmentCost: rateB?.shipmentCost,
});
check('ShipStation duplicate carrier-family accounts preserve distinct human nicknames through selected-rate DTOs',
  rateA?.shippingProviderId === 565326 &&
  rateB?.shippingProviderId === 607855 &&
  selectedA?.providerAccountNickname === 'GG6381' &&
  selectedB?.providerAccountNickname === 'ROCEL C81F70' &&
  selectedA.providerAccountId !== selectedB.providerAccountId);

const shipmentsSchema = read('src/db/schema/shipments.ts');
checkIncludesAll('shipment snapshot schema preserves provider/account selected-rate identity', shipmentsSchema, [
  'providerAccountId:',
  'providerAccountNickname:',
  'carrierProvider:',
  'carrierAccountId:',
  'labelProviderKey:',
  'selectedRateJson:',
]);

const shippingMargin = read('src/services/shipping-margin-analytics.ts');
checkIncludesAll('billing/shipping-margin read model carries display-safe account identity', shippingMargin, [
  'providerAccountId',
  'providerAccountNickname',
  'carrierCode',
  'serviceCode',
]);

if (failures > 0) {
  console.error(`\nFAIL PS-326 carrier/account identity certification guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-326 carrier/account identity certification guard');
