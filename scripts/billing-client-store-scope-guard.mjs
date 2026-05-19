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

const routeSource = read('src/routes/billing.ts');
const serviceSource = read('src/services/billing.ts');
const reportingSource = read('src/services/reporting-metrics.ts');
const packageJson = JSON.parse(read('package.json'));

assert(
  routeSource.includes('getClientStoreScope') && routeSource.includes('type ClientStoreScope'),
  'billing imports client/store scope helpers',
);
assert(
  routeSource.includes('billingScopeFromContext') &&
    routeSource.includes("c.get('clientIds'") &&
    routeSource.includes("c.get('storeIds'"),
  'billing builds scope from auth context',
);
assert(
  routeSource.includes('billingClientScopePredicate') &&
    serviceSource.includes('billingClientScopePredicate') &&
    reportingSource.includes('billingMetricsScopePredicate'),
  'billing route, service, and metrics define client scope predicates',
);
assert(
  routeSource.includes('const configScope = billingScopeFromContext(c)') &&
    routeSource.includes('billingClientScopePredicate(configScope)'),
  'billing config applies client/store scope',
);
assert(
  routeSource.includes('withBillingScope(c,') &&
    routeSource.includes('billingSummary(withBillingScope') &&
    routeSource.includes('billingDetails(withBillingScope'),
  'billing summary and details pass auth scope into service',
);
assert(
  routeSource.includes('invoiceScope') &&
    routeSource.includes('billingClientScopePredicate(invoiceScope)'),
  'billing invoice applies client/store scope before rendering',
);
assert(
  routeSource.includes('packagePriceScope') &&
    (routeSource.includes('billingClientScopePredicate(packagePriceScope)') ||
      routeSource.includes('billingClientIdScopePredicate(packagePriceScope)')),
  'billing package prices applies client/store scope',
);
assert(
  serviceSource.includes('scopeClientIds?: number[]') &&
    serviceSource.includes('scopeStoreIds?: number[]') &&
    serviceSource.includes('scopeRestricted?: boolean'),
  'billing service accepts client/store scope input',
);
assert(
  serviceSource.includes('billingLineItemScopePredicate(input)') &&
    serviceSource.includes('billingClientScopePredicate(input)') &&
    reportingSource.includes('scopeClientIds') &&
    reportingSource.includes('scopeStoreIds'),
  'billing summary/details/read-model reads apply client/store scope',
);
assert(
  packageJson.scripts?.['test:billing-client-scope'] ===
    'node scripts/billing-client-store-scope-guard.mjs',
  'package exposes billing client/store scope guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
