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
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
