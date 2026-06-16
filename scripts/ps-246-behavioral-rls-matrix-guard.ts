/**
 * PS-246 (Card 1) — behavioral client/store scope (RLS-equivalent) matrix.
 *
 * The fail-closed scope rule (PS-233/240) is the app-layer enforcement that backs the DB RLS posture.
 * This guard IMPORTS + RUNS the real classifier (getClientStoreScope) and the real enforcement
 * (isResourceInScope / assertResourceInScope) — not a substring scan — proving the matrix:
 *   - a global/unrestricted scope passes everything;
 *   - a restricted scope passes only its own clientIds/storeIds and rejects everything else;
 *   - a restricted scope with NO ids fails closed (rejects all);
 *   - assertResourceInScope throws a 404-style ResourceScopeError out-of-scope, no-ops in-scope.
 *
 *   npx tsx scripts/ps-246-behavioral-rls-matrix-guard.ts
 */
import { readFileSync } from 'node:fs';
import { getClientStoreScope } from '../src/lib/client-store-scope';
import { isResourceInScope, assertResourceInScope, ResourceScopeError } from '../src/lib/scope-predicates';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const restricted = getClientStoreScope({ role: 'client_user', clientIds: [4], storeIds: [10] });
const globalScope = getClientStoreScope({ role: 'admin', clientIds: [], storeIds: [] });
const emptyRestricted = getClientStoreScope({ role: 'client_user', clientIds: [], storeIds: [] });

check('client_user is restricted; admin is not', restricted.isRestricted === true && globalScope.isRestricted !== true);

// 1. global passes everything
check('global scope passes any resource', isResourceInScope(globalScope, { clientId: 999, storeId: 999 }) === true);

// 2. restricted rejects out-of-scope
check('restricted rejects an out-of-scope clientId', isResourceInScope(restricted, { clientId: 7, storeId: null }) === false);
check('restricted rejects an out-of-scope storeId', isResourceInScope(restricted, { clientId: null, storeId: 77 }) === false);

// 3. restricted passes in-scope (by client OR store)
check('restricted passes an in-scope clientId', isResourceInScope(restricted, { clientId: 4, storeId: null }) === true);
check('restricted passes an in-scope storeId', isResourceInScope(restricted, { clientId: null, storeId: 10 }) === true);

// 4. restricted with no ids fails closed
check('a restricted scope with NO ids fails closed (rejects everything)',
  isResourceInScope(emptyRestricted, { clientId: 4, storeId: 10 }) === false);

// 5. assertResourceInScope: 404-style throw out-of-scope, no-op in-scope
let threwOutOfScope = false;
try { assertResourceInScope(restricted, { clientId: 7 }, 'Order not found'); }
catch (e) { threwOutOfScope = e instanceof ResourceScopeError; }
check('assertResourceInScope throws a 404-style ResourceScopeError out-of-scope', threwOutOfScope);

let noopInScope = true;
try { assertResourceInScope(restricted, { clientId: 4 }); } catch { noopInScope = false; }
check('assertResourceInScope is a no-op in-scope', noopInScope);

check('package.json wires test:ps-246-behavioral-rls-matrix',
  /test:ps-246-behavioral-rls-matrix/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-246 behavioral RLS matrix guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-246 behavioral RLS matrix guard');
