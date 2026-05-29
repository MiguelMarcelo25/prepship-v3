import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const helper = readFileSync('src/lib/walmart-order-dedupe.ts', 'utf8');
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const initRoute = readFileSync('src/routes/init.ts', 'utf8');
const inventoryRoute = readFileSync('src/routes/inventory.ts', 'utf8');
const ordersSchema = readFileSync('src/db/schema/orders.ts', 'utf8');
const listCountIndexesMigration = readFileSync('drizzle/0033_orders_list_count_indexes.sql', 'utf8');
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

// /orders applies Walmart direct/ShipStation dedupe via the walmartDirectDuplicates
// directRows step (building walmartDirectDuplicateByOrderNumber) and exposes the
// per-row sourceLink + walmartDirectDuplicatesOnPage diagnostics. (Refactored
// from the earlier inline shouldApplyWalmartDedupe predicate; the predicate
// helper is still asserted against the connector + /init + /inventory paths.)
assert(
  ordersRoute.includes('walmartDirectDuplicates') &&
    ordersRoute.includes('walmartDirectDuplicateByOrderNumber') &&
    ordersRoute.includes('sourceLink') &&
    ordersRoute.includes('walmartDirectDuplicatesOnPage'),
  '/orders must apply Walmart direct duplicate suppression and expose source-link diagnostics',
);

assert(
  ordersSchema.includes("index('orders_walmart_shipstation_order_number_idx')") &&
    ordersSchema.includes("index('orders_walmart_direct_order_number_latest_idx')") &&
    listCountIndexesMigration.includes('"orders_walmart_shipstation_order_number_idx"') &&
    listCountIndexesMigration.includes('"orders_walmart_direct_order_number_latest_idx"'),
  'Walmart dedupe hot paths must have migration-owned order_number indexes',
);

// The Walmart *canonical* dedupe in /init/counts was intentionally reverted
// (da0a6936 "Revert 'Show canonical Walmart orders in linked store view'");
// direct Walmart orders are shown/counted separately by design, and
// walmartCanonicalOrderPredicate no longer exists. What /init/counts MUST still
// share with /orders is the awaiting visibility predicate so sidebar badges and
// the list reflect the same conceptual awaiting set. (Sidebar-vs-list Walmart
// count asymmetry is intentional per the revert — see the coverage matrix note
// for the DJ confirmation follow-up.)
assert(
  initRoute.includes('visibleAwaitingOrdersPredicate'),
  '/init/counts must share the awaiting visibility predicate used by /orders',
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
