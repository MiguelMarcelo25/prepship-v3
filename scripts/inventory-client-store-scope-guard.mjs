import fs from 'node:fs';
import path from 'node:path';

// ── PS-259 (Card 14) BEHAVIORAL block ─────────────────────────────────────────
// Import + RUN the real scope-enforcement owner instead of only string-scanning the
// inventory routes. These assertions FAIL if the actual restriction logic in
// src/lib/client-store-scope (getClientStoreScope) or src/lib/scope-predicates
// (isResourceInScope) were deleted/weakened — they are not tautologies. Both owners
// are pure functions whose only transitive import is ./admin-emails (no env/db), so a
// plain static import is safe under tsx. Because these are TypeScript modules, this
// .mjs must be run via tsx, not node:
//   npx tsx scripts/inventory-client-store-scope-guard.mjs
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

// A portal principal with explicit client/store ids must be classified as restricted
// (the requiresExplicitScope / hasExplicitScope branch). If that branch were removed
// the scope would default to non-restricted (isResourceInScope returns true for
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
  'OWNER isResourceInScope DENIES an out-of-scope inventory resource for a restricted client_user',
);

// …and ALLOW an in-scope resource — proves the verdict is real, not deny-everything.
assert(
  isResourceInScope(restrictedScope, { clientId: 7, storeId: 100 }) === true &&
    isResourceInScope(restrictedScope, { clientId: 500, storeId: 42 }) === true,
  'OWNER isResourceInScope ALLOWS in-scope client/store inventory resources',
);

// An admin (global) scope must bypass restriction and see any resource. Fails if the
// explicitGlobal branch were broken so admins got locked out / restricted.
const adminScope = getClientStoreScope({ role: 'admin', email: 'admin@drprepper.com' });
assert(
  adminScope.isGlobal === true &&
    adminScope.isRestricted === false &&
    isResourceInScope(adminScope, { clientId: 123456, storeId: 654321 }) === true,
  'OWNER admin/global scope is unrestricted and isResourceInScope passes any inventory resource',
);
// ──────────────────────────────────────────────────────────────────────────────

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
// Accept BOTH the legacy `node ...` and the behavioral `tsx ...` invocation so this
// guard stays green before/after the package.json run-command flip to tsx (this .mjs
// now imports TypeScript owners, which node cannot load).
assert(
  packageJson.scripts?.['test:inventory-client-scope'] ===
    'node scripts/inventory-client-store-scope-guard.mjs' ||
    packageJson.scripts?.['test:inventory-client-scope'] ===
      'tsx scripts/inventory-client-store-scope-guard.mjs',
  'package exposes inventory client/store scope guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
