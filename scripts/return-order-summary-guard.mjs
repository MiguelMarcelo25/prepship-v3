import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const readModel = read('src/services/return-order-read-model.ts');
const orders = read('src/routes/orders.ts');
const cells = read('web/src/components/Views/OrdersTableCells.tsx');
const apiTypes = read('web/src/types/api.ts');
const readiness = read('src/services/runtime-schema-readiness.ts');

let failed = false;
function check(message, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) failed = true;
}

check(
  'read model loads one latest return per page order from canonical returns',
  /select distinct on \(r\.order_id\)/.test(readModel) &&
    /r\.return_customer_shipping_rate as "returnCustomerShippingRate"/.test(readModel) &&
    /order by r\.order_id, r\.created_at desc, r\.id desc/.test(readModel),
);
check(
  'read model does not rate-shop, rank, mark up, or call a carrier',
  !/getRates|bestRate|isBlockedRate|carrierConnectors|resolveReturnCustomerPrice|billing_config/.test(readModel),
);
check(
  'orders route attaches the summary only to shipped lifecycle rows',
  /loadReturnOrderSummaries\(pageOrderIds\)/.test(orders) &&
    /const returnSummary = isShippedBucket[\s\S]{0,120}returnSummaryByOrderId\.get/.test(orders),
);
check(
  'financial RBAC redacts the return rate without hiding return status',
  /returnCustomerShippingRate: canViewFinancials[\s\S]{0,120}returnSummary\.returnCustomerShippingRate[\s\S]{0,80}: null/.test(orders),
);
check(
  'PrepShip order DTO declares the same intent-named return rate field',
  /returnSummary\?:[\s\S]{0,180}returnCustomerShippingRate: number \| null/.test(apiTypes),
);
check(
  'Shipped order cell renders the order first and a red return-rate line below',
  /order\.orderStatus === 'shipped' \? order\.returnSummary : null/.test(cells) &&
    /className="od-order-link"[\s\S]{0,2000}Return\{returnRate != null/.test(cells) &&
    /color: 'var\(--red\)'/.test(cells) &&
    /RETURN_STATUS_LABELS/.test(cells),
);
check(
  'runtime readiness requires the shared returns snapshot column',
  /'returns'/.test(readiness) &&
    /returns: \['return_customer_shipping_rate'\]/.test(readiness),
);
check(
  'the shipped-data override is documented next to every changed locked read surface',
  /Per user override unlock shipped data on 2026-05-23/.test(orders) &&
    /Per user override unlock shipped data on 2026-05-23/.test(cells),
);
check(
  'shipped and cancelled mutation locks remain present',
  /const LOCKED_STATUSES = new Set\(\['shipped', 'cancelled'\]\)/.test(orders) &&
    /async function assertOrderEditable\(/.test(orders),
);

if (failed) process.exit(1);
console.log('\nReturn order summary guard passed.');
