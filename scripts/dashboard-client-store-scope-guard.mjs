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

// ── PS-259 (Card 14) BEHAVIORAL block ─────────────────────────────────────────
// Import + RUN the real scope-enforcement owner instead of only string-scanning the
// dashboard routes. These assertions FAIL if the actual restriction logic in
// src/lib/client-store-scope (getClientStoreScope) or src/lib/scope-predicates
// (isResourceInScope) were deleted/weakened — they are not tautologies. Both owners
// are pure functions whose only transitive import is ./admin-emails (no env/db), so a
// plain static import is safe under tsx.
import { getClientStoreScope } from '../src/lib/client-store-scope';
import { isResourceInScope } from '../src/lib/scope-predicates';

// A portal principal with NO explicit client/store ids must STILL be classified as
// restricted (the requiresExplicitScope branch). If that branch were removed the
// scope would default to non-restricted (isResourceInScope returns true for
// everything) — a cross-tenant leak. This assert fails in that case.
const restrictedScope = getClientStoreScope({ role: 'client_user', clientIds: [7], storeIds: [42] });
assert(
  restrictedScope.isRestricted === true && restrictedScope.isGlobal === false,
  'OWNER getClientStoreScope marks a client_user scope as restricted (not global)',
);

const bareClientUserScope = getClientStoreScope({ role: 'client_user' });
assert(
  bareClientUserScope.isRestricted === true,
  'OWNER client_user with no explicit ids is still restricted (no default-open scope)',
);

// A restricted scope must DENY an out-of-scope resource. Fails if the restricted
// deny-path in isResourceInScope were removed.
assert(
  isResourceInScope(restrictedScope, { clientId: 999, storeId: 888 }) === false,
  'OWNER isResourceInScope DENIES an out-of-scope resource for a restricted client_user',
);

// …and ALLOW an in-scope resource — proves the verdict is real, not deny-everything.
assert(
  isResourceInScope(restrictedScope, { clientId: 7, storeId: 100 }) === true &&
    isResourceInScope(restrictedScope, { clientId: 500, storeId: 42 }) === true,
  'OWNER isResourceInScope ALLOWS in-scope client/store resources',
);

// An admin (global) scope must bypass restriction and see any resource. Fails if the
// explicitGlobal branch were broken so admins got locked out / restricted.
const adminScope = getClientStoreScope({ role: 'admin', email: 'admin@drprepper.com' });
assert(
  adminScope.isGlobal === true &&
    adminScope.isRestricted === false &&
    isResourceInScope(adminScope, { clientId: 123456, storeId: 654321 }) === true,
  'OWNER admin/global scope is unrestricted and isResourceInScope passes any resource',
);
// ──────────────────────────────────────────────────────────────────────────────

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
