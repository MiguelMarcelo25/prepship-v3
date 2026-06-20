/**
 * Label cold-start import guard.
 *
 * ORIGINAL INVARIANT (2026-06-11): the Vercel direct-carrier label function
 * api/carriers/labels.ts must NOT statically import any module that pulls env
 * validation or the DB client at module load — such static imports crashed the
 * WHOLE function as an uncatchable FUNCTION_INVOCATION_FAILED at cold start
 * whenever DATABASE_URL/SUPABASE_URL was missing/invalid, defeating env.ts's
 * throw-not-exit design. The env/db-pulling modules had to be DEFERRED into
 * ensureLabelDeps() (request time, inside the handler try/catch).
 *
 * PS-209/PS-202 REPOINT (2026-06-13): the direct-carrier label PURCHASE path was
 * retired from Vercel entirely and migrated to the v4 owner
 * src/services/labels.ts (createLabelV2), which runs in the long-lived Render
 * process where env/db are validated at boot (no per-request cold-start crash
 * class — so static imports of shipping-safety / rate-quote-snapshot-store are
 * correct there and must NOT be deferred). api/carriers/labels.ts is now a
 * NO-IMPORT 410 stub. That is the STRONGEST form of the original invariant: with
 * zero static imports there is nothing that can crash at module load.
 *
 * This guard now pins that cold-start-safe END STATE: the retired Vercel label
 * function must stay a no-import, no-purchase 410 stub. It still FAILS if anyone
 * re-introduces logic + env/db-pulling static imports into the Vercel function
 * (the exact regression the guard was built to catch).
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

// The cold-start crash class is eliminated by construction: the Vercel function
// has NO static imports at all (the strongest form of "no env/db import at load").
check('Vercel label function has NO static `import ... from` statements (zero cold-start surface)',
  !/^\s*import\s+[^;]*from\s+/m.test(src));
check('Vercel label function has NO `await import()` either (no deferred env/db load remains)',
  !/await import\(/.test(src));

// Specifically: none of the historically cold-start-unsafe modules may be
// referenced (statically OR deferred) by the retired Vercel function.
const COLD_START_UNSAFE = [
  { mod: 'shipping-safety', why: 'imports src/lib/env (throws on missing DATABASE_URL/SUPABASE_URL)' },
  { mod: 'rate-quote-snapshot-store', why: 'analytics-cache -> db/client (pg pool + env at module load)' },
  { mod: 'jose', why: 'historically static-imported the JWT verifier into the cold-start surface' },
];
for (const { mod, why } of COLD_START_UNSAFE) {
  check(`Vercel label function does not reference ${mod} (${why})`, !src.includes(mod));
}

// It must remain a retired, no-purchase 410 stub (no label-purchase capability in
// this parallel pipeline — purchases go through the v4 createLabelV2 owner).
check('Vercel label function is a retired 410 endpoint (no parallel purchase path)',
  /res\.status\(410\)/.test(src) && /LEGACY_LABEL_ENDPOINT_RETIRED/.test(src));
check('Vercel label function references the v4 createLabelV2 owner as the only label path',
  /createLabelV2/.test(src));

// The v4 owner (src/services/labels.ts) is the real label path; it runs in the
// long-lived process and legitimately STATIC-imports the shipping-safety +
// rate-quote-snapshot-store owners (no cold-start deferral needed there).
const v4 = readFileSync('src/services/labels.ts', 'utf8');
check('v4 createLabelV2 owner statically imports the shipping-safety guard owner',
  /from '\.\/fulfillment\/shipping-safety'/.test(v4) && /assertOrderSafeToShip/.test(v4));
check('v4 createLabelV2 owner statically imports the rate-quote-snapshot proof owner',
  /from '\.\/shipping-workflow\/rate-quote-snapshot-store'/.test(v4) && /assertLabelPurchaseRateSelection/.test(v4));

if (failures > 0) {
  console.error(`\nFAIL label cold-start import guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS label cold-start import guard');
