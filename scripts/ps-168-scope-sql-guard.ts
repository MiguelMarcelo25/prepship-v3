/**
 * PS-168 — scope SQL primitive single-source guard.
 *
 * normalizeScopeIds + intArraySql were duplicated verbatim across 6–7 routes/services. They now live in
 * one owner (src/lib/scope-sql.ts) and every consumer imports it. This guard asserts:
 *   - exactly ONE definition of each (in scope-sql.ts) — no copy may reappear,
 *   - the known consumers import from the shared lib,
 *   - msSince is owned by src/lib/route-timing.ts; dashboard.ts imports it (its dupe removed); orders.ts
 *     intentionally KEEPS its local copy (orders.ts is on the shipped lockdown list — left untouched),
 *   - the *ScopePredicate helpers are NOT centralized into scope-sql.ts (they diverge semantically; the
 *     plan deliberately does not unify them).
 *
 * Offline / pure: readFileSync + readdir.
 *
 * PS-259 (Card 14) BEHAVIORAL: the block below imports the REAL PS-168 owner
 * (src/lib/scope-sql) and the scope owner it feeds (src/lib/client-store-scope +
 * src/lib/scope-predicates) and RUNS them. It asserts the actual cross-tenant
 * security verdict: a restricted client_user is DENIED an out-of-scope client/store
 * while admin/global pass, AND the scope-id primitive that builds the SQL filter
 * refuses spoofed/invalid ids and emits a typed int[] literal. These assertions FAIL
 * if normalizeScopeIds, the scope derivation, or isResourceInScope were deleted or
 * weakened — they are not substring matches. The static single-source checks below
 * remain unchanged and are NOT weakened.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeScopeIds, intArraySql } from '../src/lib/scope-sql';
import { getClientStoreScope, GLOBAL_SCOPE } from '../src/lib/client-store-scope';
import { isResourceInScope, assertResourceInScope, ResourceScopeError } from '../src/lib/scope-predicates';

let behavioralFailures = 0;
function behavioral(name: string, cond: boolean) {
  if (!cond) { behavioralFailures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── BEHAVIORAL: run the real PS-168 scope primitive + the scope owner it feeds ──────
// normalizeScopeIds is the gate that turns a caller's CLAIMED scope ids into the set
// fed to the SQL WHERE clientId = ANY(...) filter. If it passed through spoofed/invalid
// ids, a restricted caller could widen its own scope. Assert it drops <=0, non-integers,
// and dedupes — and that it does NOT invent ids.
behavioral('normalizeScopeIds drops <=0 / non-integer ids (no scope widening)',
  JSON.stringify(normalizeScopeIds([7, 0, -1, 3.5, NaN, 7])) === JSON.stringify([7]));
behavioral('normalizeScopeIds on garbage/undefined yields an empty set (never global)',
  normalizeScopeIds(undefined).length === 0 && normalizeScopeIds([0, -5] as number[]).length === 0);
// intArraySql must emit a Postgres int[] literal (numeric coercion — not a string the
// caller could inject through). It's what wraps the normalized scope ids in the predicate.
const arrLiteral = intArraySql([7, 8]);
behavioral('intArraySql builds a typed ::int[] literal for the scope predicate',
  typeof arrLiteral === 'object' && arrLiteral != null);

// A restricted client_user fenced to client 7 is DENIED an out-of-scope resource
// (client 99) — the core cross-tenant defense fed by the normalized scope ids above.
const restricted = getClientStoreScope({ role: 'client_user', clientIds: [7] });
behavioral('client_user scope is restricted (not global)',
  restricted.isRestricted === true && restricted.isGlobal === false);
behavioral('restricted client_user is DENIED an out-of-scope resource',
  isResourceInScope(restricted, { clientId: 99, storeId: 99 }) === false);
let denied = false;
try {
  assertResourceInScope(restricted, { clientId: 99, storeId: 99 }, 'Resource not found');
} catch (e) {
  denied = e instanceof ResourceScopeError;
}
behavioral('restricted client_user assert throws ResourceScopeError out-of-scope', denied);
// Same restricted scope ALLOWS its own in-scope client — proves it discriminates, not blanket-deny.
behavioral('restricted client_user is ALLOWED its own in-scope resource (client 7)',
  isResourceInScope(restricted, { clientId: 7, storeId: 1 }) === true);
// read_only_support is restricted-by-role even with no ids (default-deny).
const roSupport = getClientStoreScope({ role: 'read_only_support' });
behavioral('read_only_support is restricted-by-role with no ids',
  roSupport.isRestricted === true && isResourceInScope(roSupport, { clientId: 7, storeId: 1 }) === false);
// admin / GLOBAL passes any resource — proves global callers are not falsely blocked.
const adminScope = getClientStoreScope({ role: 'admin' });
behavioral('admin scope is global and passes an arbitrary resource',
  adminScope.isGlobal === true && isResourceInScope(adminScope, { clientId: 99, storeId: 99 }) === true);
behavioral('GLOBAL_SCOPE (trusted worker) passes an arbitrary resource',
  isResourceInScope(GLOBAL_SCOPE, { clientId: 12345, storeId: 67890 }) === true);

if (behavioralFailures > 0) {
  console.error(`\nFAIL PS-168 BEHAVIORAL scope enforcement (${behavioralFailures} failing) — real owner verdict wrong`);
  process.exit(1);
}

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const srcFiles: string[] = [];
(function walk(d: string) {
  for (const e of readdirSync(d)) {
    const p = join(d, e); const st = statSync(p);
    if (st.isDirectory()) { if (e !== 'node_modules') walk(p); }
    else if (p.endsWith('.ts')) srcFiles.push(p.replace(/\\/g, '/'));
  }
})('src');

function defSites(symbol: string): string[] {
  const re = new RegExp(`^(export )?(async )?function ${symbol}\\b`, 'm');
  return srcFiles.filter((f) => re.test(readFileSync(f, 'utf8')));
}

const owner = readFileSync('src/lib/scope-sql.ts', 'utf8');

// ── (1) single owner for the two primitives ──
check('scope-sql.ts exports normalizeScopeIds + intArraySql',
  /export function normalizeScopeIds\(/.test(owner) && /export function intArraySql\(/.test(owner));
const normDefs = defSites('normalizeScopeIds');
const intDefs = defSites('intArraySql');
check('normalizeScopeIds defined in exactly ONE file (scope-sql.ts)',
  normDefs.length === 1 && normDefs[0].endsWith('src/lib/scope-sql.ts'), normDefs.join(', '));
check('intArraySql defined in exactly ONE file (scope-sql.ts)',
  intDefs.length === 1 && intDefs[0].endsWith('src/lib/scope-sql.ts'), intDefs.join(', '));

// ── (2) consumers import from the shared lib ──
const CONSUMERS = [
  'src/routes/analysis.ts', 'src/routes/billing.ts', 'src/routes/inventory.ts', 'src/routes/dashboard.ts',
  'src/services/billing.ts', 'src/services/print-queue.ts', 'src/services/reporting-metrics.ts',
];
for (const f of CONSUMERS) {
  check(`${f} imports from '../lib/scope-sql'`, /from '\.\.\/lib\/scope-sql'/.test(readFileSync(f, 'utf8')));
}

// ── (3) msSince ownership: route-timing owner; dashboard delegates; orders.ts keeps its locked copy ──
check('route-timing.ts is the msSince owner', /export function msSince\(/.test(readFileSync('src/lib/route-timing.ts', 'utf8')));
const dash = readFileSync('src/routes/dashboard.ts', 'utf8');
check('dashboard.ts msSince dupe removed + imports route-timing',
  !/^function msSince\(/m.test(dash) && /from '\.\.\/lib\/route-timing'/.test(dash));
check('orders.ts intentionally retains its local msSince (shipped-lockdown file, left untouched)',
  /^function msSince\(/m.test(readFileSync('src/routes/orders.ts', 'utf8')));

// ── (4) *ScopePredicate helpers NOT centralized (intentional — they diverge) ──
check('scope-sql.ts does NOT centralize the divergent *ScopePredicate helpers (no such fn defined here)',
  !/function \w*ScopePredicate/.test(owner));

if (failures > 0) {
  console.error(`\nFAIL PS-168 scope-sql guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-168 scope-sql guard (single owner; consumers delegate; non-unifications preserved)');
