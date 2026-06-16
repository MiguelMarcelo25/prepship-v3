/**
 * PS-255 (Card 10) guard — destructive ops are gated:
 *   - opsMayMutate defaults to a dry run; --apply/--confirm required to mutate (+ optional token),
 *   - migrate-supabase.ts (unconditional TRUNCATE…CASCADE) is dry-run-by-default,
 *   - the /admin/* router (incl. /purge-test-orders) is behind requireAdmin.
 *
 *   npx tsx scripts/ps-255-ops-confirm-gate-guard.ts
 */
import { readFileSync } from 'node:fs';
import { opsMayMutate, opsApplyRequested } from '../src/lib/ops-confirm';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── behavioral: dry-run default, explicit opt-in to mutate ───────────────────────────────────
check('no flag -> may NOT mutate (dry run default)', opsMayMutate([]) === false);
check('--apply -> may mutate', opsMayMutate(['--apply']) === true);
check('--confirm -> may mutate', opsMayMutate(['--confirm']) === true);
check('opsApplyRequested: false without flag, true with', opsApplyRequested([]) === false && opsApplyRequested(['--apply']) === true);

// ── behavioral: token gate (when required) ───────────────────────────────────────────────────
delete process.env.OPS_CONFIRM_TOKEN;
check('requireToken + no env token -> blocked even with --apply', opsMayMutate(['--apply'], { requireToken: true }) === false);
process.env.OPS_CONFIRM_TOKEN = 's3cret';
check('requireToken + wrong --token -> blocked', opsMayMutate(['--apply', '--token=nope'], { requireToken: true }) === false);
check('requireToken + matching --token -> allowed', opsMayMutate(['--apply', '--token=s3cret'], { requireToken: true }) === true);
delete process.env.OPS_CONFIRM_TOKEN;

// ── static: migrate-supabase is dry-run-by-default ───────────────────────────────────────────
const migrate = readFileSync('scripts/migrate-supabase.ts', 'utf8');
check('migrate-supabase imports opsMayMutate', /import \{ opsMayMutate \} from '\.\.\/src\/lib\/ops-confirm'/.test(migrate));
check('migrate-supabase dryRun defaults true unless --apply',
  /const dryRun = process\.argv\.includes\('--dry-run'\) \|\| !opsMayMutate\(\);/.test(migrate));

// ── static: /admin (incl. /purge-test-orders) is admin-gated at the mount ─────────────────────
const main = readFileSync('src/main.ts', 'utf8');
check("/admin/* is behind requireAdmin", /app\.use\('\/admin\/\*', requireAdmin\)/.test(main));
const admin = readFileSync('src/routes/admin.ts', 'utf8');
check('/purge-test-orders exists in the admin router (thus requireAdmin-gated)',
  /app\.post\('\/purge-test-orders'/.test(admin));

check('package.json wires test:ps-255-ops-confirm-gate',
  /test:ps-255-ops-confirm-gate/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-255 ops confirm-gate guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-255 ops confirm-gate guard');
