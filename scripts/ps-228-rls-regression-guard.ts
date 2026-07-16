/**
 * PS-228 guard — regression-proof RLS (the sole wall between the public anon key /
 * PostgREST and customer data).
 *
 * The browser bundle ships the public Supabase anon key and PostgREST is reachable,
 * so RLS deny-all is the ONLY control standing between that key and orders/clients/
 * shipments/credentials. A single migration disabling RLS, or one permissive policy,
 * is an instant data breach. This guard makes that mistake fail CI.
 *
 * Project model (project_supabase_rls_model): backend = postgres OWNER (bypasses RLS);
 * frontend = Supabase auth -> the Render API (NOT PostgREST). RLS-enabled-no-policy is
 * intentional; OPEN POLICIES must never be added.
 *
 *   npx tsx scripts/ps-228-rls-regression-guard.ts
 */
import { readFileSync, readdirSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// Strip `--` line comments so a comment that merely mentions a banned phrase
// (e.g., the explainer in 0018_security_hardening.sql) doesn't trip the scan.
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

const drizzleDir = 'drizzle';
const sqlFiles = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql'));
const allSql = stripSqlComments(
  sqlFiles.map((f) => readFileSync(`${drizzleDir}/${f}`, 'utf8')).join('\n'),
);

// 1. The cardinal rule: no migration may disable RLS on a public table.
check('no migration disables row level security', !/disable\s+row\s+level\s+security/i.test(allSql));

// 2. No open policies — the model is RLS-enabled-with-no-policy (deny-all). Any
//    CREATE POLICY must be a deliberate, separately-reviewed change.
check('no CREATE POLICY (RLS-enabled-no-policy model preserved)', !/create\s+policy/i.test(allSql));

// 3. No grants that hand table access to the public API roles.
check('no GRANT to anon/public/authenticated on tables',
  !/grant\b[^;]*\bto\s+(anon|public|authenticated)\b/i.test(allSql));

// 4. The runtime table-ensure paths (the modern create-a-table path) ALL enable RLS,
//    so a new side-table can't ship public.
const runtimeEnsures = [
  'src/services/audit-log.ts',
  'src/services/shipping-workflow/order-rate-job-status.ts',
  'src/services/shipment-tracking.ts',
];
for (const rel of runtimeEnsures) {
  let body = '';
  try { body = readFileSync(rel, 'utf8'); } catch { /* missing */ }
  const createsTable = /create table/i.test(body);
  check(`${rel} enables RLS on the table it ensures`,
    !createsTable || /enable row level security/i.test(body));
}

// 5. Defense-in-depth REVOKE migration present + revokes from the API roles.
let revoke = '';
try { revoke = readFileSync('drizzle/0045_revoke_public_api_grants.sql', 'utf8'); } catch { /* missing */ }
check('REVOKE migration exists', revoke.length > 0);
check('REVOKE migration strips anon + authenticated grants',
  /revoke[\s\S]*\banon\b/i.test(revoke) && /revoke[\s\S]*\bauthenticated\b/i.test(revoke));

// 6. Billing proof and operational 0066 backups were created after the broad
//    hardening migration. Pin their backend-only posture so later refactors
//    cannot silently reopen them through PostgREST.
let billingHardening = '';
try { billingHardening = readFileSync('drizzle/0069_public_billing_rls_hardening.sql', 'utf8'); } catch { /* missing */ }
check('billing storage proof explicitly enables RLS',
  /alter\s+table\s+public\.billing_storage_proof\s+enable\s+row\s+level\s+security/i.test(billingHardening));
check('billing storage proof revokes public API grants',
  /revoke\s+all\s+privileges\s+on\s+table\s+public\.billing_storage_proof[\s\S]*\banon\b[\s\S]*\bauthenticated\b/i.test(billingHardening));
check('0066 reference-rate backups are dynamically RLS-hardened',
  /billing_ref_rates_backup_0066_/.test(billingHardening) &&
    /enable\s+row\s+level\s+security/i.test(billingHardening) &&
    /revoke\s+all\s+privileges/i.test(billingHardening));

// 7. Posture doc + the Supabase advisors the CI should watch.
let posture = '';
try { posture = readFileSync('docs/engineering/rls-posture.md', 'utf8'); } catch { /* missing */ }
check('RLS posture doc exists', posture.length > 0);
check('doc names rls_disabled_in_public advisor', posture.includes('rls_disabled_in_public'));
check('doc names rls_enabled_no_policy advisor', posture.includes('rls_enabled_no_policy'));
check('doc documents Render owner bypasses RLS + PostgREST unused',
  /postgrest/i.test(posture) && /owner/i.test(posture));
check('doc records the anon-key re-test (reads denied)',
  /anon/i.test(posture) && /\[\]|denied|empty/i.test(posture));

// 8. Self-wiring.
const pkg = readFileSync('package.json', 'utf8');
check('package.json exposes test:ps-228-rls-regression', /test:ps-228-rls-regression/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-228 RLS regression guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-228 RLS regression guard');
