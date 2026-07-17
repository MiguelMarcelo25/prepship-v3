import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const readModel = read('src/services/return-order-read-model.ts');
const orders = read('src/routes/orders.ts');
const useOrders = read('web/src/hooks/useOrders.ts');
const table = read('web/src/components/Views/OrdersTable.tsx');
const cells = read('web/src/components/Views/OrdersTableCells.tsx');
const apiTypes = read('web/src/types/api.ts');
const readiness = read('src/services/runtime-schema-readiness.ts');

let failed = false;
function check(message, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) failed = true;
}

check(
  'read model loads every canonical return for each page order',
  !/select distinct on \(r\.order_id\)/.test(readModel) &&
    /from returns r/.test(readModel) &&
    /order by r\.order_id, r\.created_at asc, r\.id asc/.test(readModel) &&
    /Map<number, ReturnOrderSummary\[\]>/.test(readModel),
);
check(
  'return items and linked is-return shipment facts remain backend-owned',
  /from return_items ri/.test(readModel) &&
    /left join shipments s on s\.id = r\.return_shipment_id/.test(readModel) &&
    /coalesce\(s\.is_return, false\) = false/.test(readModel),
);
check(
  'read model does not rate-shop, rank, mark up, or call a carrier',
  !/getRates|bestRate|isBlockedRate|carrierConnectors|resolveReturnCustomerPrice|billing_config/.test(readModel),
);
check(
  'orders route exposes return arrays only for shipped lifecycle rows',
  /loadReturnOrderSummaries\(pageOrderIds\)/.test(orders) &&
    /const returnSummaries = isShippedBucket[\s\S]{0,140}returnSummaryByOrderId\.get/.test(orders) &&
    /returnSummaries: returnSummaries\.map/.test(orders),
);
check(
  'financial RBAC redacts every return customer rate and money tuple',
  /returnSummaries: returnSummaries\.map[\s\S]{0,220}money: canViewFinancials[\s\S]{0,120}returnCustomerShippingRate: canViewFinancials/.test(orders),
);
check(
  'PrepShip DTO declares distinct order and return display identities',
  /displayRowKey\?: string/.test(apiTypes) &&
    /displayRowKind\?: 'order' \| 'return'/.test(apiTypes) &&
    /returnSummaries\?: ReturnOrderSummaryDto\[\]/.test(apiTypes),
);
check(
  'frontend preserves the original row and adds one row per backend return',
  /function expandReturnDisplayRows/.test(useOrders) &&
    /displayRowKey: `order:\$\{order\.orderId\}`/.test(useOrders) &&
    /displayRowKey: `return:\$\{summary\.returnId\}`/.test(useOrders) &&
    /return \[originalRow, \.\.\.returnRows\]/.test(useOrders) &&
    /\.flatMap\(\(row\)/.test(useOrders),
);
check(
  'return rows use returned items and consume only backend-frozen return money',
  /Array\.isArray\(summary\.items\)/.test(useOrders) &&
    /const returnMoney = toRecordValue\(summary\.money\)/.test(useOrders) &&
    /bestRateWorkflow: returnMoney \? \{ money: returnMoney \} : null/.test(useOrders) &&
    /selectedRate: null/.test(useOrders) &&
    /bestRate: null/.test(useOrders) &&
    /cost: null/.test(useOrders),
);
check(
  'return read model exposes the strict PrepShip frozen tuple without pricing',
  /readFrozenCustomerShippingMoney\(row\.selectedRateJson\)/.test(readModel) &&
    /selectedRateCost: frozenMoney\.selectedRateCost/.test(readModel) &&
    /shippingMarginAmount: frozenMoney\.shippingMarginAmount/.test(readModel) &&
    !/resolveCustomerShippingMoney|decideShippingLineBilling/.test(readModel),
);
check(
  'table keys distinguish original and return rows sharing one order id',
  /function getDisplayRowKey/.test(table) &&
    /order\.displayRowKey \?\? `order:\$\{order\.orderId\}`/.test(table) &&
    /key=\{getDisplayRowKey\(order\)\}/.test(table),
);
check(
  'only the separate return row receives red return styling',
  /const isReturnRow = order\.displayRowKind === 'return'/.test(cells) &&
    /isReturnRow \? 'var\(--red\)' : 'var\(--ss-blue\)'/.test(cells) &&
    /Return\{returnRate != null/.test(cells),
);
check(
  'runtime readiness requires the shared returns snapshot column',
  /'returns'/.test(readiness) &&
    /returns: \['return_customer_shipping_rate'\]/.test(readiness),
);
check(
  'the shipped-data override is documented next to each changed read surface',
  /unlock shipped data` on 2026-07-16/.test(readModel) &&
    /unlock shipped data` on 2026-07-16/.test(orders) &&
    /unlock shipped data` on 2026-07-16/.test(useOrders) &&
    /unlock shipped data` on 2026-07-16/.test(table) &&
    /unlock shipped data` on 2026-07-16/.test(cells),
);
check(
  'shipped and cancelled mutation locks remain present',
  /const LOCKED_STATUSES = new Set\(\['shipped', 'cancelled'\]\)/.test(orders) &&
    /async function assertOrderEditable\(/.test(orders),
);

if (failed) process.exit(1);
console.log('\nReturn separate-row guard passed.');
