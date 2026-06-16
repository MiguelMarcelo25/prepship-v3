// PS-259 (Card 14): BEHAVIORAL conversion. This guard used to be substring-only
// (readFileSync + regex over print-queue.ts route/service), so it would still pass
// green even if the real scope enforcement were deleted. We now also IMPORT + RUN the
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
  'behavioral: restricted scope ALLOWS a print-queue row whose clientId is in scope',
);
assert(
  isResourceInScope(restricted, { clientId: 999, storeId: 42 }) === true,
  'behavioral: restricted scope ALLOWS a print-queue row whose storeId is in scope',
);

// Out-of-scope resource is DENIED — the assertion that fails if enforcement is gutted.
assert(
  isResourceInScope(restricted, { clientId: 999, storeId: 888 }) === false,
  'behavioral: restricted scope DENIES an out-of-scope print-queue row (fail-if-removed)',
);
assert(
  isResourceInScope(restricted, { clientId: null, storeId: null }) === false,
  'behavioral: restricted scope DENIES an unattributed print-queue row (no clientId/storeId)',
);

// A client_user with NO explicit ids is still restricted (can see nothing), never global —
// fail-closed. If the requiresExplicitScope branch were removed this would flip to allow-all.
const restrictedNoIds = getClientStoreScope({ role: 'client_user', clientIds: [], storeIds: [] });
assert(restrictedNoIds.isRestricted === true, 'behavioral: client_user with no ids stays RESTRICTED (fail-closed)');
assert(
  isResourceInScope(restrictedNoIds, { clientId: 7, storeId: 42 }) === false,
  'behavioral: empty-id client_user DENIES every print-queue row',
);

// An admin principal resolves to a GLOBAL (unrestricted) scope that passes everything.
const adminScope = getClientStoreScope({ role: 'admin', clientIds: [], storeIds: [] });
assert(adminScope.isGlobal === true && adminScope.isRestricted === false, 'behavioral: admin resolves to a GLOBAL scope');
assert(
  isResourceInScope(adminScope, { clientId: 999, storeId: 888 }) === true,
  'behavioral: global/admin scope ALLOWS any print-queue row',
);
assert(
  isResourceInScope(GLOBAL_SCOPE, { clientId: 123, storeId: 456 }) === true,
  'behavioral: explicit GLOBAL_SCOPE (trusted system caller) ALLOWS any print-queue row',
);

const routeSource = read('src/routes/print-queue.ts');
const serviceSource = read('src/services/print-queue.ts');
const packageJson = JSON.parse(read('package.json'));

assert(
  routeSource.includes('getInternalOpsClientStoreScope') && routeSource.includes('type ClientStoreScope'),
  'print-queue route imports internal ops client/store scope helpers',
);
assert(
  routeSource.includes('printQueueScopeFromContext') &&
    routeSource.includes("c.get('clientIds'") &&
    routeSource.includes("c.get('storeIds'"),
  'print-queue route builds internal ops scope from auth context',
);
assert(
  routeSource.includes('listQueue(q.clientId, q.includePrinted, printQueueScopeFromContext(c))'),
  'print-queue list passes auth scope into service',
);
assert(
  serviceSource.includes('type PrintQueueListScope') &&
    serviceSource.includes('scopeClientIds?: number[]') &&
    serviceSource.includes('scopeStoreIds?: number[]') &&
    serviceSource.includes('scopeRestricted?: boolean'),
  'print-queue service accepts client/store scope input',
);
assert(
  serviceSource.includes('printQueueScopePredicate') &&
    serviceSource.includes('printQueue.clientId') &&
    serviceSource.includes('clients.storeIds'),
  'print-queue service defines client/store scope predicate',
);
assert(
  serviceSource.includes('printQueueScopePredicate(scope)') &&
    serviceSource.includes('and(...conds)'),
  'print-queue list applies client/store scope predicate',
);
assert(
  // PS-259: this behavioral guard imports TS owners from ../src, so it must run via
  // tsx (the package.json wiring flips `node …` -> `tsx …`). Accept either form so the
  // guard stays green across the package.json edit (done by the wiring agent), but
  // require it to still be wired to this exact script.
  packageJson.scripts?.['test:print-queue-client-scope']?.endsWith(
    'scripts/print-queue-client-store-scope-guard.mjs',
  ) === true,
  'package exposes print-queue client/store scope guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
