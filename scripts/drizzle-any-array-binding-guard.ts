/**
 * Guard — drizzle `any(${...})` must bind a real Postgres array.
 *
 * Root cause of the Billing "invoice.xlsx → Internal server error" 500:
 * src/routes/billing.ts passed a RAW JS array to `any()` inside drizzle's
 * `db.execute(sql\`... where id = any(${billedPackageIds})\`)`. Drizzle's sql
 * template does NOT serialize a JS array as a Postgres array, so the driver bound
 * a scalar and Postgres rejected it: "op ANY/ALL (array) requires array on right
 * side". It passes typecheck AND build and only throws at runtime with real data
 * — so a static guard is the only thing that catches it.
 *
 * The codebase already has the right helper: intArraySql(values) → `array[…]::int[]`.
 * EVERY drizzle `any(${X})` must use it (or a nested sql`` expression). The ONLY
 * exception is code that calls the porsager `postgres` sql tag directly (e.g.
 * schema-readiness), which DOES bind JS arrays natively — those files are
 * allowlisted below.
 *
 *   npx tsx scripts/drizzle-any-array-binding-guard.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Files that use the porsager `postgres` sql tag directly (native array binding),
// NOT drizzle's db.execute — raw `any(${array})` is valid there.
const PORSAGER_SQL_ALLOWLIST = new Set<string>([
  'src/services/fulfillment/schema-readiness.ts',
  // PS-223 — uses the porsager `sql` tag (import { sql } from '../db/client'),
  // which binds JS arrays as Postgres arrays natively; any(${orderIds}) is valid.
  'src/services/packaging-rules.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ANY_CALL = /any\(\$\{([^}]+)\}\)/g;
let failures = 0;
const offenders: string[] = [];

for (const file of walk('src')) {
  const rel = file.replace(/\\/g, '/');
  if (PORSAGER_SQL_ALLOWLIST.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  let m: RegExpExecArray | null;
  ANY_CALL.lastIndex = 0;
  while ((m = ANY_CALL.exec(text)) !== null) {
    const expr = m[1]!.trim();
    // Acceptable: the int-array helper, or a nested sql`` array expression.
    const ok = expr.startsWith('intArraySql(') || expr.startsWith('sql`') || expr.startsWith('sql.');
    if (!ok) {
      failures += 1;
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(`${rel}:${line}  any(\${${expr}})  — wrap in intArraySql(...)`);
    }
  }
}

if (failures > 0) {
  console.error('FAIL drizzle any() array-binding guard — raw JS array passed to any():\n');
  for (const o of offenders) console.error('  ' + o);
  console.error('\nUse intArraySql(values) so drizzle emits array[…]::int[] (see src/lib/scope-sql.ts).');
  console.error(`\n${failures} offending site(s).`);
  process.exit(1);
}
console.log('ok   every drizzle any(${...}) binds a Postgres array via intArraySql() (porsager-sql files allowlisted)');
console.log('\nPASS drizzle any() array-binding guard');
