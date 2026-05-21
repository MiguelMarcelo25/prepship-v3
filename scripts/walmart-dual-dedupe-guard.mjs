import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const helper = readFileSync('src/lib/walmart-order-dedupe.ts', 'utf8');
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const initRoute = readFileSync('src/routes/init.ts', 'utf8');
const inventoryRoute = readFileSync('src/routes/inventory.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert(
  helper.includes('WALMART_SHIPSTATION_STORE_ID = 376661') &&
    helper.includes('WALMART_DIRECT_STORE_ID = 9_000_001'),
  'Walmart dedupe helper must encode the linked ShipStation/direct Walmart store ids',
);

assert(
  helper.includes('walmartDirectDuplicateSuppressionPredicate') &&
    helper.includes('walmart_shipstation_order.store_id') &&
    helper.includes('walmart_shipstation_order.order_number'),
  'Walmart dedupe helper must suppress direct duplicates by matching ShipStation order_number',
);

assert(
  ordersRoute.includes('walmartDirectDuplicateSuppressionPredicate') &&
    ordersRoute.includes('sourceLink') &&
    ordersRoute.includes('walmartDirectDuplicates'),
  '/orders must apply Walmart direct duplicate suppression and expose source-link diagnostics',
);

assert(
  initRoute.includes('walmartDirectDuplicateSuppressionPredicate') &&
    initRoute.includes('walmartCanonicalOrderPredicate'),
  '/init/counts must apply the same Walmart canonical dedupe rule as /orders',
);

assert(
  inventoryRoute.includes("import { walmartDirectDuplicateSuppressionPredicate }") &&
    inventoryRoute.includes("walmartDirectDuplicateSuppressionPredicate('o')") &&
    inventoryRoute.includes('walmartCanonicalOrderFilter') &&
    inventoryRoute.includes("'/:id{[0-9]+}/sku-orders'"),
  '/inventory/:id/sku-orders must apply Walmart canonical dedupe for Analysis SKU drawer data',
);

assert(
  pkg.scripts?.['test:walmart-dual-dedupe'] === 'node scripts/walmart-dual-dedupe-guard.mjs',
  'package.json must expose test:walmart-dual-dedupe',
);

console.log('PASS Walmart dual-source dedupe guard');
