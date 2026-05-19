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

const routeSource = read('src/routes/inventory.ts');
const serviceSource = read('src/services/inventory.ts');
const packageJson = JSON.parse(read('package.json'));

assert(
  routeSource.includes('getClientStoreScope') && routeSource.includes('type ClientStoreScope'),
  'inventory imports client/store scope helpers',
);
assert(
  routeSource.includes('inventoryScopeFromContext') &&
    routeSource.includes("c.get('clientIds'") &&
    routeSource.includes("c.get('storeIds'"),
  'inventory builds scope from auth context',
);
assert(
  routeSource.includes('inventoryScopePredicate') &&
    routeSource.includes('inventoryOrderScopePredicate'),
  'inventory defines inventory and order scope predicates',
);
assert(
  routeSource.includes('const scope = inventoryScopeFromContext(c)') &&
    routeSource.includes('inventoryScopePredicate(scope)'),
  'inventory list applies client/store scope',
);
assert(
  routeSource.includes('ledgerScope') &&
    routeSource.includes('inventoryScopePredicate(ledgerScope)'),
  'inventory ledger applies client/store scope',
);
assert(
  routeSource.includes('alertsScope') &&
    routeSource.includes('inventoryScopePredicate(alertsScope)'),
  'inventory alerts applies client/store scope',
);
assert(
  routeSource.includes('inventoryStats(') &&
    routeSource.includes('inventoryScopePredicate(statsScope)') &&
    serviceSource.includes('scopePredicate'),
  'inventory stats passes client/store scope into service',
);
assert(
  routeSource.includes('detailScope') &&
    routeSource.includes('ledgerDetailScope') &&
    routeSource.includes('parentsScope'),
  'inventory detail, detail ledger, and parents reads build scope',
);
assert(
  routeSource.includes('skuOrdersScope') &&
    routeSource.includes('inventoryOrderScopePredicate(skuOrdersScope)'),
  'inventory SKU-orders analytics applies order client/store scope',
);
assert(
  packageJson.scripts?.['test:inventory-client-scope'] ===
    'node scripts/inventory-client-store-scope-guard.mjs',
  'package exposes inventory client/store scope guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
