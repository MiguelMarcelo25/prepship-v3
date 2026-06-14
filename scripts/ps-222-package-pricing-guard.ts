/**
 * PS-222 guard — the package-pricing seeder is SAFE BY DEFAULT.
 *
 * PS-222's engine (scripts/ps-222-package-pricing-seed.ts) turns DJ's supplied
 * pricing data into packages.unit_cost + client_package_prices rows so the box-cost
 * billing line can populate. Because it CAN write production pricing, this guard pins
 * that it never writes unless --apply is passed: the default is a read-only presence
 * audit, --input alone is a dry-run, and the only mutations live inside one
 * sql.begin transaction reached only after the !APPLY early return.
 *
 *   npx tsx scripts/ps-222-package-pricing-guard.ts
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

const SEED = 'scripts/ps-222-package-pricing-seed.ts';
const seed = read(SEED);
const pkg = read('package.json');

check('seeder exists', existsSync(SEED));

// 1. --apply is the only thing that enables writes.
check('APPLY is derived from the --apply flag',
  /const APPLY = process\.argv\.includes\('--apply'\)/.test(seed));

// 2. The default (no flags) is the read-only presence audit.
check('default mode is the read-only presence audit',
  /if \(!inputPath\) \{ await presenceAudit\(\); return; \}/.test(seed));

// 3. The presence audit performs NO writes (only SELECTs).
const auditStart = seed.indexOf('async function presenceAudit');
const auditEnd = seed.indexOf('async function resolvePackageId');
const auditBody = auditStart >= 0 && auditEnd > auditStart ? seed.slice(auditStart, auditEnd) : seed;
check('presence audit is read-only (no insert/update)',
  !/\binsert\s+into\b|\bupdate\s+\w+\s+set\b/i.test(auditBody));

// 4. All mutations live inside ONE sql.begin transaction, gated behind the apply check.
check('writes happen inside a single sql.begin transaction', seed.includes('await sql.begin('));
const applyGate = seed.indexOf('if (!APPLY)');
const txStart = seed.indexOf('await sql.begin(');
check('dry-run returns BEFORE any write (!APPLY early-return precedes sql.begin)',
  applyGate >= 0 && txStart > applyGate && /if \(!APPLY\) \{[\s\S]{0,160}return;/.test(seed));
// No write statement appears before the apply gate.
const beforeGate = applyGate >= 0 ? seed.slice(0, applyGate) : seed;
check('no insert/update executes before the apply gate',
  !/await tx`|await sql`\s*insert|await sql`\s*update/i.test(beforeGate));

// 5. The $0 / no-charge billing caveat is documented (deferred PS-222b), not silent.
check('$0 no-charge billing-suppression caveat is documented',
  seed.includes('PS-222b') && /suppress/i.test(seed));

// 6. Wiring.
check('package.json wires the audit command', /ps-222:pricing:audit/.test(pkg));
check('package.json wires test:ps-222-package-pricing', /test:ps-222-package-pricing/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-222 package-pricing guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-222 package-pricing guard');
