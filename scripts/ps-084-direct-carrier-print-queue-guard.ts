import fs from 'node:fs';

const checks: Array<[string, boolean]> = [];

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

function check(name: string, passed: boolean): void {
  checks.push([name, passed]);
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}`);
}

const directLabels = read('api/carriers/labels.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const directQueueStart = ordersView.indexOf('async function createDirectCarrierLabelThenQueue');
const directQueueEnd = ordersView.indexOf('async function sendOrdersToQueueBackend', directQueueStart);
const directQueueFn = directQueueStart >= 0 && directQueueEnd > directQueueStart
  ? ordersView.slice(directQueueStart, directQueueEnd)
  : '';

check(
  'direct-carrier resolver accepts loaded local order row as ship-to source',
  /function resolveShipTo\(body: any, rawOrder: any, orderRow: any\)/.test(directLabels) &&
    directLabels.includes('resolveLocalOrderShipTo(orderRow'),
);

check(
  'local order query selects canonical ship-to columns before provider calls',
  directLabels.includes('o.ship_to_name') &&
    directLabels.includes('o.ship_to_city') &&
    directLabels.includes('o.ship_to_state') &&
    directLabels.includes('o.ship_to_postal_code'),
);

check(
  'ship-to validation blocks incomplete local address before label purchase',
  directLabels.includes('validateResolvedShipTo') &&
    directLabels.includes('no postage was purchased'),
);

check(
  'direct-carrier provider branches resolve ship-to with local order fallback',
  directLabels.includes('const shipTo = resolveShipTo(body, rawOrder, orderRow);'),
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
