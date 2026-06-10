/**
 * Label/print-queue audit (2026-06-11) guard — the Vercel direct-carrier label function
 * api/carriers/labels.ts must NOT statically import any module that pulls env validation or the DB
 * client at module load. Those static imports crashed the WHOLE function as an uncatchable
 * FUNCTION_INVOCATION_FAILED at cold start whenever a required env var (DATABASE_URL/SUPABASE_URL)
 * was missing/invalid — defeating env.ts's design (it throws-not-process.exit so the handler returns
 * a clean, actionable 500). The env/db-pulling modules MUST be deferred into ensureLabelDeps()
 * (request time, inside the handler try/catch).
 *
 * Pure leaves (direct-carrier-scope, address-classification) may stay static.
 *
 *   npx tsx scripts/label-coldstart-import-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`ok   ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const src = readFileSync('api/carriers/labels.ts', 'utf8');

// Modules that transitively throw env validation / construct the pg pool at module load.
const COLD_START_UNSAFE = [
  { mod: 'shipping-safety', why: 'imports src/lib/env (throws on missing DATABASE_URL/SUPABASE_URL)' },
  { mod: 'rate-quote-snapshot-store', why: 'analytics-cache -> db/client (pg pool + env at module load)' },
];

const staticImport = (mod: string) =>
  new RegExp(`^\\s*import\\s+[^;]*from\\s+['"][^'"]*${mod}[^'"]*['"]`, 'm');
const deferredImport = (mod: string) =>
  new RegExp(`await import\\(['"][^'"]*${mod}[^'"]*['"]\\)`);

for (const { mod, why } of COLD_START_UNSAFE) {
  check(`no STATIC import of ${mod} (${why})`, !staticImport(mod).test(src));
  check(`${mod} is DEFERRED via await import() in ensureLabelDeps`, deferredImport(mod).test(src));
}

// The deferred symbols must be declared as module-level lets and assigned in ensureLabelDeps.
for (const sym of ['assertOrderSafeToShip', 'ShippingSafetyError', 'assertLabelPurchaseRateSelection']) {
  check(`${sym} declared as a deferred let`, new RegExp(`let ${sym}\\b`).test(src));
}

// ensureLabelDeps must still be awaited inside the handler before any deferred symbol is used.
check('ensureLabelDeps is awaited in the handler', /await ensureLabelDeps\(\)/.test(src));

if (failures > 0) {
  console.error(`\nFAIL label cold-start import guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS label cold-start import guard');
