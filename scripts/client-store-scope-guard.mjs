// PS-259 (Card 14): converted from a substring-only guard into a BEHAVIORAL one.
// It now imports the REAL scope owners and RUNS them on representative principals,
// asserting the actual security verdict (restricted client_user is denied an
// out-of-scope resource; a global/admin scope passes). Those assertions FAIL if the
// enforcement in src/lib/client-store-scope.ts or src/lib/scope-predicates.ts were
// deleted/broken — they are not tautologies. The original static route/source checks
// below are kept unchanged. Owners import only ./admin-emails (no DB/env), so a plain
// static import is safe; this file therefore must run via `tsx`, not bare `node`.
import fs from 'node:fs';
import path from 'node:path';
import { getClientStoreScope, GLOBAL_SCOPE } from '../src/lib/client-store-scope';
import { isResourceInScope, assertResourceInScope, ResourceScopeError } from '../src/lib/scope-predicates';

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

// ── BEHAVIORAL: run the real scope owners and assert the security verdict ───────────────────────
// A restricted client_user is scoped to client 7 / store 70; resources outside that
// scope MUST be denied, in-scope resources MUST be allowed, and a global/admin scope
// MUST see everything. If getClientStoreScope stopped marking the role restricted, or
// isResourceInScope/assertResourceInScope stopped filtering, these checks would flip.
{
  const restricted = getClientStoreScope({ role: 'client_user', clientIds: [7], storeIds: [70] });
  assert(restricted.isRestricted === true && restricted.isGlobal === false,
    'BEHAVIORAL: client_user with assigned client/store is a RESTRICTED scope');
  assert(isResourceInScope(restricted, { clientId: 7, storeId: null }) === true,
    'BEHAVIORAL: restricted client_user is ALLOWED its in-scope client resource');
  assert(isResourceInScope(restricted, { clientId: null, storeId: 70 }) === true,
    'BEHAVIORAL: restricted client_user is ALLOWED its in-scope store resource');
  assert(isResourceInScope(restricted, { clientId: 999, storeId: 8888 }) === false,
    'BEHAVIORAL: restricted client_user is DENIED an out-of-scope resource (cross-tenant)');

  // A role with NO assigned claims is still externally-restricted (can't see anything) —
  // proves requiresExplicitScope, not just hasExplicitScope, drives the verdict.
  const restrictedNoClaims = getClientStoreScope({ role: 'read_only_support', clientIds: [], storeIds: [] });
  assert(restrictedNoClaims.isRestricted === true,
    'BEHAVIORAL: read_only_support with no claims is still RESTRICTED');
  assert(isResourceInScope(restrictedNoClaims, { clientId: 1, storeId: 1 }) === false,
    'BEHAVIORAL: read_only_support with no claims is DENIED every resource');

  // An admin / explicit-global scope is unrestricted and passes any resource.
  const adminScope = getClientStoreScope({ role: 'admin', clientIds: [7], storeIds: [70] });
  assert(adminScope.isGlobal === true && adminScope.isRestricted === false,
    'BEHAVIORAL: admin ignores assigned claims and is GLOBAL/unrestricted');
  assert(isResourceInScope(adminScope, { clientId: 999, storeId: 8888 }) === true,
    'BEHAVIORAL: admin (global) is ALLOWED any resource');
  assert(isResourceInScope(GLOBAL_SCOPE, { clientId: 999, storeId: 8888 }) === true,
    'BEHAVIORAL: GLOBAL_SCOPE trusted-caller sentinel passes any resource');

  // assertResourceInScope must THROW ResourceScopeError for an out-of-scope resource
  // (the 404-style guard routes rely on) and be a no-op for an in-scope one.
  let threw = false;
  try { assertResourceInScope(restricted, { clientId: 999, storeId: 8888 }); }
  catch (e) { threw = e instanceof ResourceScopeError; }
  assert(threw === true,
    'BEHAVIORAL: assertResourceInScope THROWS ResourceScopeError for an out-of-scope resource');
  let didNotThrow = true;
  try { assertResourceInScope(restricted, { clientId: 7, storeId: null }); }
  catch { didNotThrow = false; }
  assert(didNotThrow === true,
    'BEHAVIORAL: assertResourceInScope is a no-op for an in-scope resource');
}

const authSource = read('src/middleware/auth.ts');
const scopeSource = fs.existsSync(path.join(root, 'src/lib/client-store-scope.ts'))
  ? read('src/lib/client-store-scope.ts')
  : '';
const clientsSource = read('src/routes/clients.ts');
const initSource = read('src/routes/init.ts');

assert(authSource.includes('clientIds?: number[]'), 'auth vars include clientIds');
assert(authSource.includes('storeIds?: number[]'), 'auth vars include storeIds');
assert(authSource.includes('clientIds') && authSource.includes('client_ids'), 'auth reads camel/snake client scope claims');
assert(authSource.includes('storeIds') && authSource.includes('store_ids'), 'auth reads camel/snake store scope claims');
assert(authSource.includes("c.set('clientIds'") && authSource.includes("c.set('storeIds'"), 'auth stores scope vars on context');

assert(scopeSource.includes('getClientStoreScope'), 'client/store scope helper exposes getClientStoreScope');
assert(scopeSource.includes('getInternalOpsClientStoreScope'), 'client/store scope helper exposes internal ops scope helper');
assert(scopeSource.includes('filterClientsForScope'), 'client/store scope helper filters client rows');
assert(scopeSource.includes('isClientVisibleToScope'), 'client/store scope helper checks single client visibility');
assert(scopeSource.includes('client_user') && scopeSource.includes('read_only_support'), 'client/store scope helper handles externally scoped roles');
assert(scopeSource.includes('scope:global'), 'client/store scope helper supports explicit global scope permission');
assert(
  scopeSource.includes("auth.role === 'operator'") &&
    scopeSource.includes("auth.role === 'warehouse'") &&
    !scopeSource.includes("auth.permissions?.includes('print_queue:write')"),
  'internal roles stay global, while print_queue:write alone does not widen tenant scope',
);
assert(
  scopeSource.includes('if (explicitGlobal)') &&
    scopeSource.includes('clientIds: []') &&
    scopeSource.includes('storeIds: []') &&
    scopeSource.includes('isRestricted: false'),
  'global admins ignore assigned client/store claims and keep unrestricted scope',
);

assert(
  clientsSource.includes('filterClientsForScope') &&
    clientsSource.includes('getClientStoreScope') &&
    clientsSource.includes('isClientVisibleToScope'),
  'clients route uses client/store scope helpers',
);
assert(
  clientsSource.includes('filterClientsForScope(safeRows') &&
    clientsSource.includes('isClientVisibleToScope(safeRow'),
  'clients list/detail responses are scope filtered',
);

assert(
  initSource.includes('filterClientsForScope') &&
    initSource.includes('getClientStoreScope'),
  'init route uses client/store scope helpers',
);
assert(
  initSource.includes('visibleClients') &&
    initSource.includes('clients: visibleClients') &&
    initSource.includes('for (const cli of visibleClients'),
  'init-data and stores payloads use scoped clients',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
