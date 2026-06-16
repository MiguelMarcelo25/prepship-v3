// PS-259 (Card 14): BEHAVIORAL conversion. This guard used to be substring-only
// (readFileSync + regex over orders.ts/manifests.ts), so it would still pass green
// even if the real scope enforcement were deleted. We now also IMPORT + RUN the
// actual scope owners and assert the security verdict — these checks FAIL if
// getClientStoreScope or isResourceInScope were removed/broken. The static
// route/source checks below are KEPT unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { getClientStoreScope, GLOBAL_SCOPE } from '../src/lib/client-store-scope';
import { isResourceInScope } from '../src/lib/scope-predicates';

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

// ── BEHAVIORAL: run the real scope owners on representative principals/resources ──
// A restricted client_user scoped to client 7 / store 42. These assertions encode
// the actual security property: in-scope rows are visible, out-of-scope rows are
// denied. If isResourceInScope's restricted-deny branch were deleted (return true),
// the "denied" assertions below would fail; if getClientStoreScope stopped marking
// client_user as restricted, they would also fail.
const restricted = getClientStoreScope({
  role: 'client_user',
  clientIds: [7],
  storeIds: [42],
});
assert(restricted.isRestricted === true, 'behavioral: client_user with explicit ids is a RESTRICTED scope');
assert(restricted.isGlobal === false, 'behavioral: client_user scope is NOT global');

// In-scope resources are allowed.
assert(
  isResourceInScope(restricted, { clientId: 7, storeId: 999 }) === true,
  'behavioral: restricted scope ALLOWS a resource whose clientId is in scope',
);
assert(
  isResourceInScope(restricted, { clientId: 999, storeId: 42 }) === true,
  'behavioral: restricted scope ALLOWS a resource whose storeId is in scope',
);

// Out-of-scope resource is DENIED — the assertion that fails if enforcement is gutted.
assert(
  isResourceInScope(restricted, { clientId: 999, storeId: 888 }) === false,
  'behavioral: restricted scope DENIES an out-of-scope resource (fail-if-removed)',
);
assert(
  isResourceInScope(restricted, { clientId: null, storeId: null }) === false,
  'behavioral: restricted scope DENIES an unattributed resource (no clientId/storeId)',
);

// A client_user with NO explicit ids is still restricted (can see nothing), never global —
// fail-closed. If the requiresExplicitScope branch were removed this would flip to allow-all.
const restrictedNoIds = getClientStoreScope({ role: 'client_user', clientIds: [], storeIds: [] });
assert(restrictedNoIds.isRestricted === true, 'behavioral: client_user with no ids stays RESTRICTED (fail-closed)');
assert(
  isResourceInScope(restrictedNoIds, { clientId: 7, storeId: 42 }) === false,
  'behavioral: empty-id client_user DENIES every resource',
);

// An admin principal resolves to a GLOBAL (unrestricted) scope that passes everything.
const adminScope = getClientStoreScope({ role: 'admin', clientIds: [], storeIds: [] });
assert(adminScope.isGlobal === true && adminScope.isRestricted === false, 'behavioral: admin resolves to a GLOBAL scope');
assert(
  isResourceInScope(adminScope, { clientId: 999, storeId: 888 }) === true,
  'behavioral: global/admin scope ALLOWS any resource',
);
assert(
  isResourceInScope(GLOBAL_SCOPE, { clientId: 123, storeId: 456 }) === true,
  'behavioral: explicit GLOBAL_SCOPE (trusted system caller) ALLOWS any resource',
);

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
  // PS-259: this behavioral guard imports TS owners from ../src, so it must run via
  // tsx (the package.json wiring flips `node …` -> `tsx …`). Accept either form so the
  // guard stays green across the package.json edit (done by the wiring agent), but
  // require it to still be wired to this exact script.
  packageJson.scripts?.['test:orders-manifests-scope']?.endsWith(
    'scripts/orders-manifests-client-store-scope-guard.mjs',
  ) === true,
  'package exposes orders/manifests client/store scope guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
