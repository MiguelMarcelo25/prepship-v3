/**
 * PS-276 (slice 2b-2b) guard — the resolver is WIRED into the rate paths with an env-based USPS loader.
 *
 * Pins: (1) the default USPS validator reads global env creds (USPS_CONSUMER_KEY/USPS_CONSUMER_SECRET)
 * and returns null (-> no evidence) when unconfigured; (2) resolveAddressClassification uses it as the
 * default; (3) browse + backfill BOTH resolve (async upstream) and feed the result into the SAME shared
 * evidence owner, so their residential fingerprint stays identical; (4) it's still ENV-GATED — OFF
 * returns {} before any cache/USPS, so wiring it changes nothing until ADDRESS_RESOLVER=on.
 *
 *   npx tsx scripts/ps-276-resolver-wiring-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const resolver = readFileSync('src/services/shipping-workflow/resolve-address-classification.ts', 'utf8');
const browse = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8');
const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');

// ── 1. Env-based USPS loader (USPS AV is a GLOBAL service) ─────────────────────
check('envUspsValidate reads global env creds USPS_CONSUMER_KEY + USPS_CONSUMER_SECRET',
  /process\.env\.USPS_CONSUMER_KEY/.test(resolver) && /process\.env\.USPS_CONSUMER_SECRET/.test(resolver));
check('envUspsValidate calls the connector validateUspsAddress + returns null when unconfigured/no street1',
  /import \{ validateUspsAddress \} from '\.\.\/\.\.\/connectors\/carrier\/usps'/.test(resolver) &&
    /if \(!consumerKey \|\| !consumerSecret \|\| !street1\) return null;/.test(resolver) &&
    /return validateUspsAddress\(/.test(resolver));
check('resolveAddressClassification defaults to envUspsValidate (no dep needed at call sites)',
  /const validateUsps = deps\.validateUsps \?\? envUspsValidate;/.test(resolver));

// ── 2. Still ENV-GATED: OFF returns {} before any cache/USPS (inert) ──────────
check('resolver stays gated — mode off short-circuits before the cache/validator',
  /const mode = deps\.mode \?\? addressResolverMode\(\);\s*\n\s*if \(mode === 'off'\) return \{\};/.test(resolver));

// ── 3. Browse + backfill BOTH resolve upstream + feed the shared owner ─────────
check('browse resolves the address (async upstream) + passes resolved into the evidence owner',
  /const browseResolved = await resolveAddressClassification\(\{/.test(browse) &&
    /resolved: browseResolved,/.test(browse));
check('backfill resolves the address + passes resolved into the evidence owner (same as browse)',
  /const backfillResolved = await resolveAddressClassification\(\{/.test(backfill) &&
    /resolved: backfillResolved,/.test(backfill));

check('package.json wires test:ps-276-resolver-wiring',
  /test:ps-276-resolver-wiring/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-276 resolver wiring guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-276 resolver wiring guard');
