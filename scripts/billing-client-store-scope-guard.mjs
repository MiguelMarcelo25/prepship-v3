import fs from 'node:fs';
import path from 'node:path';

// PS-259 (Card 14) — BEHAVIORAL: import + RUN the real scope enforcement owners so this
// guard fails if that enforcement is deleted/broken, not just if a substring disappears.
// The billing route/service derive their client/store scope from getClientStoreScope and
// gate already-loaded resources with isResourceInScope — these are the canonical owners.
// Both modules are pure (no env-validating imports), so a static `from '../src/...'` import
// is safe; the ratchet (authz-guard-behavioral-ratchet-guard.ts) classifies this guard as
// behavioral on the presence of that import AND we actually execute the verdicts below.
import { getClientStoreScope } from '../src/lib/client-store-scope';
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

// ── BEHAVIORAL: run the real scope owners on representative billing principals ──────────────
// A restricted client_user scoped to client #7 must be DENIED an out-of-scope client (#99) and
// ALLOWED its in-scope client (#7); an admin/global scope must pass any resource. Every
// assertion below FAILS if getClientStoreScope or isResourceInScope is removed/broken — e.g.
// if isResourceInScope reverted to `return true`, the deny check flips to a fail.
const restrictedScope = getClientStoreScope({
  role: 'client_user',
  clientIds: [7],
  storeIds: [42],
});
assert(
  restrictedScope.isRestricted === true && restrictedScope.isGlobal === false,
  'behavioral: client_user with clientIds is a RESTRICTED (non-global) scope',
);
assert(
  isResourceInScope(restrictedScope, { clientId: 99, storeId: 999 }) === false,
  'behavioral: restricted billing scope DENIES an out-of-scope client/store resource',
);
assert(
  isResourceInScope(restrictedScope, { clientId: 7, storeId: null }) === true,
  'behavioral: restricted billing scope ALLOWS its in-scope client resource',
);
assert(
  isResourceInScope(restrictedScope, { clientId: null, storeId: 42 }) === true,
  'behavioral: restricted billing scope ALLOWS its in-scope store resource',
);

const adminScope = getClientStoreScope({ role: 'admin', clientIds: [7], storeIds: [42] });
assert(
  adminScope.isGlobal === true && adminScope.isRestricted === false,
  'behavioral: admin role yields a GLOBAL (unrestricted) billing scope, ignoring client/store ids',
);
assert(
  isResourceInScope(adminScope, { clientId: 99, storeId: 999 }) === true,
  'behavioral: global/admin billing scope passes any resource (no per-tenant restriction)',
);

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
  routeSource.includes('if (scope.isGlobal) return sql`true`;') &&
    serviceSource.includes('if (input.scopeIsGlobal === true) return sql`true`;') &&
    reportingSource.includes('if (options.scopeIsGlobal === true) return sql`true`;'),
  'billing predicates and read model ignore client/store ids for global/admin users',
);
assert(
  routeSource.includes('const configScope = billingScopeFromContext(c)') &&
    routeSource.includes('billingClientScopePredicate(configScope)'),
  'billing config applies client/store scope',
);
assert(
  routeSource.includes('withBillingScope(c,') &&
    routeSource.includes('generateLineItems(withBillingScope(c,') &&
    routeSource.includes('billingSummary(withBillingScope') &&
    routeSource.includes('billingDetails(withBillingScope'),
  'billing generate, summary, and details pass auth scope into service',
);
assert(
  routeSource.includes('invoiceScope') &&
    routeSource.includes('billingClientScopePredicate(invoiceScope)'),
  'billing invoice applies client/store scope before rendering',
);
assert(
  routeSource.includes('const totalQty = baseQty + addlQty') &&
    routeSource.includes('<th class="num">Qty</th>') &&
    !routeSource.includes('<th class="num">Base Qty</th>') &&
    routeSource.includes('${addlQty > 0 ? fmt(additionalAmt) :') &&
    !routeSource.includes('${addlQty > 0 ? `${addlQty} (${fmt(additionalAmt)})`'),
  'billing invoice renders total quantity and addl-unit fee without quantity parentheses',
);
assert(
  routeSource.includes('packagePriceScope') &&
    (routeSource.includes('billingClientScopePredicate(packagePriceScope)') ||
      routeSource.includes('billingClientIdScopePredicate(packagePriceScope)') ||
      (routeSource.includes('canAccessBillingClient(clientId, packagePriceScope)') &&
        routeSource.includes('function canAccessBillingClient') &&
        routeSource.includes('billingClientScopePredicate(scope)'))),
  'billing package prices applies client/store scope',
);
assert(
  serviceSource.includes('scopeClientIds?: number[]') &&
    serviceSource.includes('scopeStoreIds?: number[]') &&
    serviceSource.includes('scopeIsGlobal?: boolean') &&
    reportingSource.includes('scopeIsGlobal?: boolean') &&
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
  serviceSource.includes('billingLineItemScopePredicate(input, sql`b.client_id`)'),
  'aliased billing freshness query applies restricted scope through its b.client_id alias',
);
// PS-259: this guard now imports TypeScript owners, so it MUST run via tsx (node cannot
// import .ts). Accept either runner so the guard does not flash red during the out-of-band
// package.json flip from `node` -> `tsx`, but require it still targets this script.
assert(
  ['tsx scripts/billing-client-store-scope-guard.mjs', 'node scripts/billing-client-store-scope-guard.mjs'].includes(
    packageJson.scripts?.['test:billing-client-scope'],
  ),
  'package exposes billing client/store scope guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
