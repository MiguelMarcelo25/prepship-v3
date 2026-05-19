import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

const ordersSource = read('src/routes/orders.ts');
const manifestsSource = read('src/routes/manifests.ts');
const packageJson = JSON.parse(read('package.json'));

assert(
  ordersSource.includes('getClientStoreScope') && ordersSource.includes('type ClientStoreScope'),
  'orders route imports client/store scope helpers',
);
assert(
  ordersSource.includes('ordersScopeFromContext') &&
    ordersSource.includes("c.get('clientIds'") &&
    ordersSource.includes("c.get('storeIds'"),
  'orders route builds scope from auth context',
);
assert(
  ordersSource.includes('orderScopePredicate') &&
    ordersSource.includes('orderAliasScopePredicate'),
  'orders route defines Drizzle and raw-SQL scope predicates',
);
assert(
  ordersSource.includes('const orderScope = ordersScopeFromContext(c)') &&
    ordersSource.includes('orderScopePredicate(orderScope)'),
  'orders list applies client/store scope',
);
assert(
  ordersSource.includes('const dailyCountsScope = ordersScopeFromContext(c)') &&
    ordersSource.includes('orderScopePredicate(dailyCountsScope)'),
  'orders daily-counts applies client/store scope',
);
assert(
  ordersSource.includes('const dashboardSalesScope = ordersScopeFromContext(c)') &&
    ordersSource.includes('orderScopePredicate(dashboardSalesScope)'),
  'orders dashboard-sales compatibility route applies client/store scope',
);
assert(
  ordersSource.includes('const idsScope = ordersScopeFromContext(c)') &&
    ordersSource.includes("orderAliasScopePredicate('o', idsScope)"),
  'orders SKU id lookup applies client/store scope',
);
assert(
  ordersSource.includes('const storeCountsScope = ordersScopeFromContext(c)') &&
    ordersSource.includes("orderAliasScopePredicate('orders', storeCountsScope)"),
  'orders store-counts applies client/store scope',
);
assert(
  ordersSource.includes('const dailyStatsScope = ordersScopeFromContext(c)') &&
    ordersSource.includes("orderAliasScopePredicate('o', dailyStatsScope)"),
  'orders daily-stats applies client/store scope',
);
assert(
  ordersSource.includes('const picklistScope = ordersScopeFromContext(c)') &&
    ordersSource.includes("orderAliasScopePredicate('o', picklistScope)"),
  'orders picklist applies client/store scope',
);
assert(
  ordersSource.includes('const distinctSkusScope = ordersScopeFromContext(c)') &&
    ordersSource.includes("orderAliasScopePredicate('o', distinctSkusScope)"),
  'orders distinct SKU lookup applies client/store scope',
);
assert(
  ordersSource.includes('const byNumberScope = ordersScopeFromContext(c)') &&
    ordersSource.includes('orderScopePredicate(byNumberScope)'),
  'orders by-number lookup applies client/store scope',
);
assert(
  ordersSource.includes('const detailScope = ordersScopeFromContext(c)') &&
    ordersSource.includes('orderScopePredicate(detailScope)') &&
    ordersSource.includes('const fullDetailScope = ordersScopeFromContext(c)') &&
    ordersSource.includes('orderScopePredicate(fullDetailScope)'),
  'orders detail and full detail apply client/store scope',
);
assert(
  ordersSource.includes('const exportScope = ordersScopeFromContext(c)') &&
    ordersSource.includes('orderScopePredicate(exportScope)'),
  'orders export applies client/store scope',
);

assert(
  manifestsSource.includes('getClientStoreScope') &&
    manifestsSource.includes('type ClientStoreScope'),
  'manifests route imports client/store scope helpers',
);
assert(
  manifestsSource.includes('manifestScopeFromContext') &&
    manifestsSource.includes("c.get('clientIds'") &&
    manifestsSource.includes("c.get('storeIds'"),
  'manifests route builds scope from auth context',
);
assert(
  manifestsSource.includes('manifestClientScopePredicate') &&
    manifestsSource.includes('scope?: ClientStoreScope'),
  'manifests route defines scoped manifest filters',
);
assert(
  manifestsSource.includes('scope: manifestScopeFromContext(c)'),
  'manifest generate routes pass client/store scope',
);
assert(
  packageJson.scripts?.['test:orders-manifests-scope'] ===
    'node scripts/orders-manifests-client-store-scope-guard.mjs',
  'package exposes orders/manifests client/store scope guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
