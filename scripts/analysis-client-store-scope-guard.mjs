import fs from 'node:fs';
import path from 'node:path';

// PS-259 (Card 14) — BEHAVIORAL: import + RUN the real scope enforcement owners so this
// guard fails if that enforcement is deleted/broken, not just if a substring disappears.
// The analysis route derives its client/store scope from getClientStoreScope and gates
// already-loaded resources with isResourceInScope — these are the canonical owners.
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

// ── BEHAVIORAL: run the real scope owners on representative analysis principals ──────────────
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
  'behavioral: restricted analysis scope DENIES an out-of-scope client/store resource',
);
assert(
  isResourceInScope(restrictedScope, { clientId: 7, storeId: null }) === true,
  'behavioral: restricted analysis scope ALLOWS its in-scope client resource',
);
assert(
  isResourceInScope(restrictedScope, { clientId: null, storeId: 42 }) === true,
  'behavioral: restricted analysis scope ALLOWS its in-scope store resource',
);

const adminScope = getClientStoreScope({ role: 'admin', clientIds: [7], storeIds: [42] });
assert(
  adminScope.isGlobal === true && adminScope.isRestricted === false,
  'behavioral: admin role yields a GLOBAL (unrestricted) analysis scope, ignoring client/store ids',
);
assert(
  isResourceInScope(adminScope, { clientId: 99, storeId: 999 }) === true,
  'behavioral: global/admin analysis scope passes any resource (no per-tenant restriction)',
);

const packageJson = JSON.parse(read('package.json'));
const source = read('src/routes/analysis.ts');

assert(
  source.includes('getClientStoreScope') && source.includes('type ClientStoreScope'),
  'analysis imports client/store scope helpers',
);
assert(
  source.includes('analysisScopeFromContext') &&
    source.includes("c.get('clientIds'") &&
    source.includes("c.get('storeIds'"),
  'analysis builds scope from auth context',
);
assert(
  source.includes('withAnalysisScope') &&
    source.includes('clientIds: scope.clientIds') &&
    source.includes('storeIds: scope.storeIds') &&
    source.includes('scopeRestricted: scope.isRestricted'),
  'analysis attaches auth scope to query helpers',
);
assert(
  source.includes('analysisOrderScopePredicate') &&
    source.includes('analysisShipmentScopePredicate'),
  'analysis defines order and shipment scope predicates',
);
assert(
  source.includes('and ${analysisOrderScopePredicate(scope)}') &&
    source.includes('and ${analysisShipmentScopePredicate(scope)}'),
  'analysis overview applies order and shipment scope predicates',
);
assert(
  source.includes('dailyShipmentsScope') &&
    source.includes('and ${analysisShipmentScopePredicate(dailyShipmentsScope)}'),
  'analysis daily shipments applies shipment scope predicate',
);
assert(
  source.includes('topSkusScope') &&
    source.includes('and ${analysisOrderScopePredicate(topSkusScope)}'),
  'analysis top-skus applies order scope predicate',
);
assert(
  source.includes('getSkuDaily(withAnalysisScope(c, c.req.valid') &&
    source.includes('getSkuBreakdown(withAnalysisScope(c, c.req.valid'),
  'analysis sku routes pass context scope into shared helpers',
);
// PS-259: this guard now imports TypeScript owners, so it MUST run via tsx (node cannot
// import .ts). Accept either runner so the guard does not flash red during the out-of-band
// package.json flip from `node` -> `tsx`, but require it still targets this script.
assert(
  [
    'tsx scripts/analysis-client-store-scope-guard.mjs',
    'node scripts/analysis-client-store-scope-guard.mjs',
  ].includes(packageJson.scripts?.['test:analysis-client-scope']),
  'package exposes analysis client/store scope guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
