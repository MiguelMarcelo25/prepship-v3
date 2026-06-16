/**
 * PS-245 (Card 0) guard — the lockdown fence logic is correct (offline, no git dependency).
 *
 * BEHAVIORAL: runs the pure fence matchers. STATIC: the CI driver reads the diff + honors the
 * override phrase, and both commands are wired.
 *
 *   npx tsx scripts/ps-245-lockdown-fence-guard.ts
 */
import { readFileSync } from 'node:fs';
import { matchesGlob, globToRegExp, lockdownPathsTouched, hasLockdownOverride, LOCKDOWN_GLOBS } from './fence-match';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── pure matchers ─────────────────────────────────────────────────────────────────────────────
check('exact path matches its glob', matchesGlob('src/db/schema/shipments.ts', 'src/db/schema/shipments.ts'));
check('* matches a single path segment', matchesGlob('src/routes/orders.ts', 'src/routes/*.ts'));
check('* does NOT cross a slash', !matchesGlob('src/routes/sub/x.ts', 'src/routes/*.ts'));
check('** matches across slashes', matchesGlob('api/carriers/deep/x.ts', 'api/**'));
check('backslashes normalized to forward slashes', matchesGlob('src\\db\\schema\\orders.ts', 'src/db/schema/orders.ts'));
// anchored (no partial matches) + the glob's dot is literal, not a wildcard:
check('match is anchored at the start', !matchesGlob('xsrc/db/schema/orders.ts', 'src/db/schema/orders.ts'));
check('match is anchored at the end', !matchesGlob('src/db/schema/orders.tsx', 'src/db/schema/orders.ts'));
check('a literal dot is not treated as a wildcard', !matchesGlob('src/db/schema/ordersXts', 'src/db/schema/orders.ts'));
check('globToRegExp returns a RegExp', globToRegExp('a/b.ts') instanceof RegExp);

// ── lockdown detection ──────────────────────────────────────────────────────────────────────
check('flags shipments schema among a mixed diff',
  lockdownPathsTouched(['src/db/schema/shipments.ts', 'src/routes/rates.ts']).length === 1);
check('flags the inventory-deduction kill-switch service',
  lockdownPathsTouched(['src/services/fulfillment-deductions.ts']).length === 1);
check('ignores non-locked (awaiting) files',
  lockdownPathsTouched(['src/routes/rates.ts', 'web/src/components/Views/RatesView.tsx']).length === 0);
check('LOCKDOWN_GLOBS covers shipments schema + deduction service',
  LOCKDOWN_GLOBS.includes('src/db/schema/shipments.ts') && LOCKDOWN_GLOBS.includes('src/services/fulfillment-deductions.ts'));

// ── override-phrase detection (the bypass procedure) ──────────────────────────────────────────
check('override phrase detected (case-insensitive)', hasLockdownOverride('PS-x fix\n\nUnlock Shipped Data on 2026-06-16') === true);
check('no override phrase -> not overridden', hasLockdownOverride('PS-x: ordinary change') === false);

// ── static: the CI driver reads the diff + honors the override + is wired (out of default profile) ──
const driver = readFileSync('scripts/verify-lockdown-fence.ts', 'utf8');
check('driver computes the diff via git diff --name-only', /git diff --name-only/.test(driver));
check('driver honors the override before failing', /hasLockdownOverride\(messages\)/.test(driver));
const pkg = readFileSync('package.json', 'utf8');
check('package.json wires verify:lockdown-fence (CI driver, NOT test:*)', /"verify:lockdown-fence":/.test(pkg));
check('package.json wires test:ps-245-lockdown-fence', /test:ps-245-lockdown-fence/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-245 lockdown fence guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-245 lockdown fence guard');
