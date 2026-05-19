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

const dashboardSource = read('src/routes/dashboard.ts');
const analysisSource = read('src/routes/analysis.ts');

assert(
  dashboardSource.includes('getClientStoreScope') &&
    dashboardSource.includes('type ClientStoreScope'),
  'dashboard imports client/store scope helpers',
);
assert(
  dashboardSource.includes('dashboardScopeFromContext') &&
    dashboardSource.includes("c.get('clientIds'") &&
    dashboardSource.includes("c.get('storeIds'"),
  'dashboard builds scope from auth context',
);
assert(
  dashboardSource.includes('orderScopePredicate') &&
    dashboardSource.includes('inventoryScopePredicate'),
  'dashboard defines order and inventory scope predicates',
);
assert(
  dashboardSource.includes('orderScopePredicate(scope)') &&
    dashboardSource.includes('const scope = dashboardScopeFromContext(c)'),
  'dashboard order visibility applies client/store scope',
);
assert(
  dashboardSource.includes('inventoryScopePredicate(scope)') &&
    dashboardSource.includes('reportingMetricsAllowed'),
  'dashboard inventory-risk applies client scope before metrics fallback',
);
assert(
  dashboardSource.includes('clientIds: scope.clientIds') &&
    dashboardSource.includes('storeIds: scope.storeIds'),
  'dashboard passes scope to analysis-backed SKU panels',
);
assert(
  dashboardSource.includes('dashboardCallerCacheScope(c, scope)'),
  'dashboard cache keys include client/store scope',
);

assert(
  analysisSource.includes('clientIds?: number[]') &&
    analysisSource.includes('storeIds?: number[]') &&
    analysisSource.includes('storeId: z.coerce.number().int().optional()'),
  'analysis SKU helper query types accept client/store scope',
);
assert(
  analysisSource.includes('analysisOrderScopePredicate') &&
    analysisSource.includes('and ${analysisOrderScopePredicate(q)}'),
  'analysis SKU helpers apply client/store scope predicates',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
