import fs from 'node:fs';

const checks: Array<[string, boolean]> = [];

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

function check(name: string, passed: boolean): void {
  checks.push([name, passed]);
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}`);
}

const labelsSvc = read('src/services/labels.ts');
const labelsDirect = read('src/services/labels-direct.ts');
const printQueueSvc = read('src/services/print-queue.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');

// PS-317 A4: the FRONTEND direct-carrier label BUY (createDirectCarrierLabelThenQueue,
// which called apiClient.createLabel = POST /labels) was DELETED. The frontend now buys
// NOTHING — every queue order routes to the backend create/recover job via
// sendOrdersToQueueBackend, which posts the queue-send INTENT (buildQueueSendOrderPayload)
// to the backend, where createLabelV2 owns the purchase. The canonical-shipTo + proof +
// account-binding this guard used to pin on the FE function now lives server-side
// (carrierShipTo in labels.ts) and in the intent payload — see the re-pointed checks below.
const buildQueuePayloadStart = ordersView.indexOf('function buildQueueSendOrderPayload');
const buildQueuePayloadEnd = ordersView.indexOf('async function pollBackendQueueSendJob', buildQueuePayloadStart);
const buildQueuePayloadFn = buildQueuePayloadStart >= 0 && buildQueuePayloadEnd > buildQueuePayloadStart
  ? ordersView.slice(buildQueuePayloadStart, buildQueuePayloadEnd)
  : '';

check(
  'v4 label owner resolves carrier-safe ship-to from the loaded order row',
  labelsSvc.includes('resolveCarrierRecipientName') &&
    labelsSvc.includes('customerEmail: order.customerEmail'),
);

check(
  'v4 label owner keeps original shipTo for classification before provider calls',
  /classifyShippingAddress\(\{[\s\S]*?name: shipTo\.name[\s\S]*?company: shipTo\.company/.test(labelsSvc),
);

check(
  'v4 label owner creates a separate carrierShipTo payload',
  /const carrierShipTo: ShipstationAddressInput = \{[\s\S]*?name: carrierRecipient\.name[\s\S]*?company: carrierRecipient\.company/.test(labelsSvc),
);

check(
  'direct-carrier provider branch receives carrierShipTo through labels-direct',
  /shipTo: carrierShipTo,[\s\S]*?shippingOptions: options/.test(labelsSvc) &&
    labelsDirect.includes('shipTo: args.shipTo'),
);

// PS-317 A4 (anti-regression): the FE direct-carrier label BUY must be GONE. The
// frontend may no longer own the direct-carrier purchase — no createDirectCarrierLabelThenQueue
// helper, and the Print-to-Queue path must NOT buy a label client-side via apiClient.createLabel;
// it routes to the backend create/recover job through sendOrdersToQueueBackend instead.
check(
  'FE direct-carrier label buy is removed — queue routes to the backend, not apiClient.createLabel',
  !ordersView.includes('createDirectCarrierLabelThenQueue') &&
    ordersView.includes('sendOrdersToQueueBackend') &&
    // the only surviving apiClient.createLabel call sites are the Create+Print / batch-print
    // flows (mode !== 'queue'); the queue branches return early via sendOrdersToQueueBackend.
    /if \(mode === 'queue'\)[\s\S]*?await sendOrdersToQueueBackend\(\[order\]/.test(ordersView) &&
    /if \(mode === 'queue'\)[\s\S]*?await sendOrdersToQueueBackend\(batchOrders/.test(ordersView),
);

// PS-317 A4 (re-pointed to the INTENT payload): the canonical account-binding + rate proof
// the deleted FE buy used to carry is now SENT to the backend in the queue-send intent
// (buildQueueSendOrderPayload), not used to buy a label on the client. The backend owner
// (createLabelV2) derives the carrier-safe shipTo and runs the proof/eligibility gate.
check(
  'queue-send intent payload carries provider-account binding + selected-rate proof to the backend',
  /selectedRateProof: buildSelectedRateProofPayload\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(buildQueuePayloadFn) &&
    /\.\.\.buildRateQuoteRefForOrder\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(buildQueuePayloadFn) &&
    /shippingProviderId: shippingProviderId \?\? undefined/.test(buildQueuePayloadFn),
);

// PS-317 A4 (re-pointed to the BACKEND owner): the canonical carrier-safe shipTo that the
// deleted FE function built (getShipTo) now lives server-side as carrierShipTo in labels.ts,
// handed to the direct-carrier connector; and the print-queue worker delegates the purchase
// to createLabelV2 (so the queue path goes through the same backend create/recover boundary).
check(
  'backend owns the direct-carrier print-queue purchase via createLabelV2 + carrier-safe carrierShipTo',
  /createLabelV2\(\{[\s\S]*?\.\.\.order\.label/.test(printQueueSvc) &&
    printQueueSvc.includes("import { createLabelV2") &&
    /if \(directRef\)[\s\S]*?createDirectCarrierLabelForOrder\(\{[\s\S]*?shipTo: carrierShipTo/.test(labelsSvc),
);

check(
  'existing-label queue recovery handles shipped/cancelled/already-exists without buying duplicate postage',
  ordersView.includes('queueExistingLabelAfterCreateConflict') &&
    ordersView.includes('apiClient.retrieveLabel(order.orderId, true)') &&
    ordersView.includes('Existing label added to print queue'),
);

const failures = checks.filter(([, passed]) => !passed);
if (failures.length) {
  console.error(`\nFAIL PS-084 direct-carrier print queue guard (${failures.length} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-084 direct-carrier print queue guard');
