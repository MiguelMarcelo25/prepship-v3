/**
 * PS-318 guard - shipping workflow certification matrix over existing backend owners.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * voids, no marketplace notifications, no production data mutation, and no
 * shipped/cancelled mutation. This guard certifies existing backend owners and
 * matrix coverage; it must not create a new shipping workflow owner.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildShipmentConfirmationLifecyclePlan,
} from '../src/services/fulfillment/outbox';
import {
  buildMarketplaceConfirmationIdentity,
} from '../src/services/fulfillment/confirmation-payload';
import {
  decideShippingSafety,
} from '../src/services/fulfillment/shipping-safety';
import {
  classifyQueueOrderRouteServer,
  planQueueRouteForOrders,
} from '../src/services/print-queue/queue-route-orchestrator';

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
const ps318DocPath = 'docs/ps-tickets/ps-318-shipping-workflow-certification-matrix.md';
const ps318Doc = read(ps318DocPath);

check('PS-318 certification matrix doc exists', existsSync(ps318DocPath));
checkIncludesAll('PS-318 doc names workflow rows and backend owners', ps318Doc, [
  'Shipping workflow certification matrix',
  'Awaiting row loads backend-owned shipping/rate/display state',
  'Best Rate / selected-rate proof',
  'Create + Print',
  'Print Queue',
  'Shipment persists frozen provider/rate/label snapshot',
  'Shipped row renders actual shipment truth',
  'Fulfillment outbox / marketplace confirmation lifecycle',
  'Billing/inventory side effects',
  'src/services/shipping-workflow/best-rate-workflow-dto.ts',
  'src/services/labels.ts#createLabelV2',
  'src/services/print-queue.ts',
  'src/services/fulfillment/outbox.ts',
  'src/services/fulfillment/shipping-safety.ts',
  'src/services/fulfillment-deductions.ts',
]);
checkIncludesAll('PS-318 doc includes store/provider matrix coverage and caveats', ps318Doc, [
  'HUGRAB / ShipStation-source',
  'Walmart-source',
  'eBay / eBay Shipping or ShipStation-synced eBay',
  'Direct carrier / Shipp / EasyPost',
  'not_applicable',
  'not_supported',
  'fixture/mock/offline only',
  'live canary required',
]);
checkIncludesAll('PS-318 doc records safety limits and no new owner rule', ps318Doc, [
  'PS-318 does not create a new shipping workflow owner',
  'No real labels',
  'No postage',
  'No voids',
  'No marketplace notifications',
  'No production shipped/cancelled mutation',
  'No customer PII',
]);
checkIncludesAll('PS-318 doc records reused commands', ps318Doc, [
  'guard:shipping-certification',
  'test:shipping-roundtrip-certification',
  'test:ps-085-shipping-workflow',
  'test:ps-098-shipping-purchase-boundary',
  'test:ps-300-backend-shipping-authority',
  'test:ps-303-print-queue-authority',
  'test:ps-317-fe-buy-anti-regression',
  'test:direct-carrier-labels',
  'test:direct-carrier-queue-route',
  'test:carrier-harness',
  'test:ps-285-marketplace-confirm-boundary',
  'test:ps-064-confirmation-outbox',
]);

check('package wires PS-318 shipping workflow certification guard',
  /"test:ps-318-shipping-workflow-certification"\s*:\s*"tsx scripts\/ps-318-shipping-workflow-certification-guard\.ts"/.test(packageJson));

for (const command of [
  'guard:shipping-certification',
  'test:shipping-roundtrip-certification',
  'test:ps-085-shipping-workflow',
  'test:ps-098-shipping-purchase-boundary',
  'test:ps-300-backend-shipping-authority',
  'test:ps-303-print-queue-authority',
  'test:ps-317-fe-buy-anti-regression',
  'test:direct-carrier-labels',
  'test:direct-carrier-queue-route',
  'test:carrier-harness',
  'test:walmart-confirmation:payload',
  'test:ps-285-marketplace-confirm-boundary',
  'test:ps-064-confirmation-outbox',
  'test:shipstation-label-url',
]) {
  check(`package keeps predecessor shipping workflow guard ${command}`, packageJson.includes(`"${command}"`));
}

check('shipping safety owner blocks duplicate/terminal shipping states before side effects',
  decideShippingSafety({ orderStatus: 'shipped' }).safe === false &&
  decideShippingSafety({ orderStatus: 'cancelled' }).safe === false &&
  decideShippingSafety({ orderStatus: 'awaiting_shipment', externallyShipped: true }).code === 'externally_shipped' &&
  decideShippingSafety({ orderStatus: 'awaiting_shipment' }).safe === true);

check('backend queue route owner preserves never-buy rungs and direct-via-backend cutover',
  classifyQueueOrderRouteServer({
    hasQueueableLabel: true,
    isTest: false,
    isDirectCarrier: true,
  }) === 'backend' &&
  classifyQueueOrderRouteServer({
    hasQueueableLabel: false,
    isTest: false,
    isDirectCarrier: true,
  }) === 'direct-create' &&
  classifyQueueOrderRouteServer({
    hasQueueableLabel: false,
    isTest: false,
    isDirectCarrier: true,
  }, { directViaBackend: true }) === 'backend' &&
  planQueueRouteForOrders([
    {
      orderId: 3181,
      route: {
        hasQueueableLabel: false,
        isTest: false,
        isDirectCarrier: true,
      },
    },
  ], { directViaBackend: true }).backendOrderIds.includes(3181));

const walmartIdentity = buildMarketplaceConfirmationIdentity('walmart', {
  externalOrderId: 'walmart-PO-318',
  raw: { purchaseOrderId: 'PO-318', accountId: 'store-7' },
});
const ebayIdentity = buildMarketplaceConfirmationIdentity('ebay', {
  externalOrderId: 'ebay-ORDER-318',
  raw: {
    orderId: 'ORDER-318',
    storeAccountId: 'ebay-store-7',
    lineItems: [
      { lineItemId: 'line-1', quantity: 2 },
      { line_item_id: 'line-2', quantity: 1 },
    ],
  },
});
check('marketplace identity owner derives Walmart and eBay confirmation identity without label context',
  walmartIdentity.purchaseOrderId === 'PO-318' &&
  walmartIdentity.storeAccountId === 'store-7' &&
  ebayIdentity.ebayOrderId === 'ORDER-318' &&
  Array.isArray(ebayIdentity.lineItems) &&
  ebayIdentity.lineItems.length === 2);

const noTrackingPlan = buildShipmentConfirmationLifecyclePlan({
  orderId: 318,
  orderNumber: 'PS-318-NO-TRACKING',
  shipmentId: 8318,
  externalOrderId: 'manual-318',
  sourceProvider: 'manual',
  sourceOrderId: null,
  trackingNumber: null,
  carrierCode: 'ups',
  shipDate: '2026-06-26',
});
const walmartPlan = buildShipmentConfirmationLifecyclePlan({
  orderId: 319,
  orderNumber: 'PS-318-WALMART',
  shipmentId: 8319,
  externalOrderId: 'walmart-PO-319',
  sourceProvider: 'walmart',
  sourceOrderId: 'PO-319',
  trackingNumber: '1Z318',
  carrierCode: 'ups',
  shipDate: '2026-06-26',
});
check('fulfillment lifecycle planner returns explicit not-applicable/not-supported/create states',
  noTrackingPlan.plannedAction === 'mark_not_required_no_tracking' &&
  walmartPlan.provider === 'walmart' &&
  ['create_outbox_pending', 'mark_not_supported'].includes(walmartPlan.plannedAction));

const labels = read('src/services/labels.ts');
checkPatterns('createLabelV2 owns safety, proof, provider purchase, shipment snapshot, deductions, and confirmation enqueue', labels, [
  /await assertOrderSafeToShip\(order, \{ entryPoint: 'createLabelV2' \}\)/,
  /await assertLabelPurchaseRateSelection\(\{/,
  /createDirectCarrierLabelForOrder\(\{/,
  /createCarrierLabel\('shipstation'/,
  /async function persistCreatedLabel/,
  /selectedRateJson:/,
  /providerAccountNickname:/,
  /carrierProvider:/,
  /deductPackageForShipment/,
  /deductInventoryForOrder/,
  /captureRealizedHouseMargin/,
  /enqueueShipmentConfirmation\(\{/,
  /orderStatus: 'shipped'/,
]);
check('createLabelV2 safety and proof gates run before provider purchase branches',
  (() => {
    const safetyIndex = labels.indexOf("await assertOrderSafeToShip(order, { entryPoint: 'createLabelV2' });");
    const proofIndex = labels.indexOf('await assertLabelPurchaseRateSelection({', safetyIndex);
    const directIndex = labels.indexOf('createDirectCarrierLabelForOrder({', proofIndex);
    const shipstationIndex = labels.indexOf("createCarrierLabel('shipstation'", proofIndex);
    return safetyIndex > 0 && proofIndex > safetyIndex && directIndex > proofIndex && shipstationIndex > proofIndex;
  })());

const printQueue = read('src/services/print-queue.ts');
checkPatterns('Print Queue owner creates/recovers/queues labels through backend services', printQueue, [
  /findExistingQueueableLabelForOrder/,
  /const created = await timeQueueStep\([\s\S]{0,220}\(\) => createLabelV2\(\{/,
  /recoverCreatedLabelUrl/,
  /normalizePrintQueueLabelUrl\(labelUrl\)/,
  /await timeQueueStep\([\s\S]{0,220}\(\) => addToQueue\(\{/,
  /classifyLabelPurchaseRetry\(err\)/,
  /ensureShipmentConfirmationLifecycle\(\{/,
  /processFulfillmentOutboxOnce\(\{ orderId: parsedOrderId/,
  /loadShippingHoldsForOrderIds/,
]);

const outbox = read('src/services/fulfillment/outbox.ts');
checkPatterns('fulfillment outbox owner records explicit confirmation lifecycle states', outbox, [
  /export function buildShipmentConfirmationLifecyclePlan/,
  /plannedAction: 'mark_not_required'/,
  /plannedAction: 'mark_not_supported'/,
  /plannedAction: 'create_outbox_pending'/,
  /export async function enqueueShipmentConfirmation/,
  /export async function processFulfillmentOutboxOnce/,
  /provider === 'walmart'/,
  /provider !== 'walmart' && provider !== 'ebay'/,
]);

const ordersView = read('web/src/components/Views/OrdersView.tsx');
const apiClient = read('web/src/lib/v2-apiClient.ts');
check('frontend direct-carrier buy remains deleted; OrdersView sends backend job intent only',
  !ordersView.includes('createDirectCarrierLabelThenQueue') &&
  ordersView.includes('frontend no longer buys ANY label') &&
  ordersView.includes('backendJobOrders') &&
  ordersView.includes('function buildQueueSendOrderPayload') &&
  /api\.post<[^>]*>\(\s*['"]\/labels['"]/.test(apiClient));

const shipmentsSchema = read('src/db/schema/shipments.ts');
checkIncludesAll('shipments schema preserves frozen label/provider/rate snapshot fields', shipmentsSchema, [
  'labelUrl:',
  'labelCost:',
  'selectedRateJson:',
  'providerAccountNickname:',
  'carrierProvider:',
  'confirmationStatus:',
]);

const shippingMargin = read('src/services/shipping-margin-analytics.ts');
const fulfillmentDeductions = read('src/services/fulfillment-deductions.ts');
checkPatterns('billing/inventory side effects stay with backend owners and kill switches', shippingMargin + fulfillmentDeductions, [
  /Read-only shipping-margin analytics/,
  /billing_line_items\.shipping\.total_cost/,
  /shipments\.cost_plus_other_cost/,
  /providerAccountNickname/,
  /INVENTORY_AUTO_DEDUCT/,
  /return \{ deducted: 0, skipped: true, lockedDown: true \}/,
  /return \{ deducted: false, reason: 'lockdown' as const \}/,
]);

const roundtrip = read('scripts/shipping-roundtrip-certification.mjs');
checkIncludesAll('roundtrip certification runner already carries sanitized store/provider matrix', roundtrip, [
  'storeMatrix',
  "client: 'HUGRAB'",
  "client: 'Walmart - DJC'",
  'CarrierConnector label/rate fixture',
  'Walmart StoreConnector',
  'fixture/mock/offline only; no labels, postage, live marketplace notifications, or production shipped/cancelled mutations',
]);

if (failures > 0) {
  console.error(`\nFAIL PS-318 shipping workflow certification guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-318 shipping workflow certification guard');
