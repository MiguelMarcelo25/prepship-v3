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
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const directQueueStart = ordersView.indexOf('async function createDirectCarrierLabelThenQueue');
const directQueueEnd = ordersView.indexOf('async function sendOrdersToQueueBackend', directQueueStart);
const directQueueFn = directQueueStart >= 0 && directQueueEnd > directQueueStart
  ? ordersView.slice(directQueueStart, directQueueEnd)
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

check(
  'direct-carrier print-to-queue payload includes canonical shipTo like normal label flow',
  /const shipTo = getShipTo\(order, orderDetail\)/.test(directQueueFn) &&
    /shipTo: \{[\s\S]+postalCode: shipTo\.postalCode/.test(directQueueFn),
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
