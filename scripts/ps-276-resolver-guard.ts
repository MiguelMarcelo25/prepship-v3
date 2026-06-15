/**
 * PS-276 (slice 2b) guard — the address-classification resolver (USPS-first), env-gated + money-safe.
 *
 * Pins the money-safety core (USPS business=Y -> commercial, N -> residential, ambiguous -> NO marker)
 * and that the resolver is INERT until ADDRESS_RESOLVER=on (the live-call canary) and never throws
 * into a quote. The pure normalizer + cache-row mapping + the OFF path are exercised offline; the live
 * cache/USPS path is the env-gated 2b-2 activation (not run here).
 *
 *   npx tsx scripts/ps-276-resolver-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  addressResolverMode,
  evidenceFromCacheRow,
  normalizeBusinessMarker,
  normalizeUspsAddressClassification,
  resolveAddressClassification,
} from '../src/services/shipping-workflow/resolve-address-classification';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

async function main(): Promise<void> {
  // ── 1. Money-safe business-marker normalization ─────────────────────────────
  check("business 'Y' -> commercial (true)", normalizeBusinessMarker('Y') === true);
  check("business 'N' -> residential (false)", normalizeBusinessMarker('N') === false);
  check('business true/false pass through', normalizeBusinessMarker(true) === true && normalizeBusinessMarker(false) === false);
  check("ambiguous (MIXED/UNKNOWN/empty/null) -> null (NO marker, money-safe)",
    normalizeBusinessMarker('MIXED') === null &&
    normalizeBusinessMarker('UNKNOWN') === null &&
    normalizeBusinessMarker(undefined) === null &&
    normalizeBusinessMarker(null) === null);

  // ── 2. USPS result -> trusted evidence (validated tier) ─────────────────────
  const commercial = normalizeUspsAddressClassification({
    additionalInfo: { business: 'Y', DPVConfirmation: 'Y' },
    standardized: { ZIPPlus4: '0123', carrierRoute: 'C001' },
  });
  check('USPS business Y -> addressValidation.business true + dpv/zip4/route carried',
    commercial.addressValidation?.business === true &&
    commercial.addressValidation?.dpvConfirmation === 'Y' &&
    commercial.addressValidation?.zipPlus4 === '0123' &&
    commercial.addressValidation?.carrierRoute === 'C001');
  check('USPS business N -> addressValidation.business false',
    normalizeUspsAddressClassification({ additionalInfo: { business: 'N' } }).addressValidation?.business === false);
  check('USPS ambiguous -> NO addressValidation marker (residential-safe)',
    !normalizeUspsAddressClassification({ additionalInfo: { business: 'MIXED' } }).addressValidation &&
    !normalizeUspsAddressClassification(null).addressValidation);

  // ── 3. Cache-row -> evidence mapping ────────────────────────────────────────
  check('cache row business=true -> addressValidation marker',
    evidenceFromCacheRow({ business: true, dpvConfirmation: 'Y', zipPlus4: '0001', carrierRoute: null, providerClassification: null, provider: 'usps' } as never).addressValidation?.business === true);
  check('cache row providerClassification=commercial -> providerMarker',
    evidenceFromCacheRow({ business: null, providerClassification: 'commercial', provider: 'ups', dpvConfirmation: null, zipPlus4: null, carrierRoute: null } as never).providerMarker?.classification === 'commercial');
  check('null cache row -> {}', Object.keys(evidenceFromCacheRow(null)).length === 0);

  // ── 4. Env gate: default OFF + OFF is inert (no cache/USPS touch, never throws) ──
  check('addressResolverMode defaults to off', addressResolverMode() === 'off');
  let offResult: unknown = 'unset';
  let threw = false;
  try {
    offResult = await resolveAddressClassification(
      { street1: '123 Main St', state: 'TX', postalCode: '77422', country: 'US' },
      { mode: 'off' },
    );
  } catch { threw = true; }
  check('mode=off returns {} inert (no DB/USPS), never throws',
    !threw && offResult != null && Object.keys(offResult as object).length === 0);

  // ── 5. Static: env-gate + best-effort + injectable validator ────────────────
  const src = readFileSync('src/services/shipping-workflow/resolve-address-classification.ts', 'utf8');
  check('env gate is ADDRESS_RESOLVER === on (default off)',
    /process\.env\.ADDRESS_RESOLVER === 'on' \? 'on' : 'off'/.test(src));
  check('resolver outage is swallowed (catch -> {}; never blocks a quote)',
    /catch \{\s*return \{\};/.test(src));
  check('USPS validator is injectable (validateUsps dep) — cred-loading + wiring is 2b-2',
    /validateUsps\?: \(input: ResolveAddressInput\) => Promise<UspsValidationResult>/.test(src));

  check('package.json wires test:ps-276-resolver',
    /test:ps-276-resolver/.test(readFileSync('package.json', 'utf8')));

  if (failures > 0) {
    console.error(`\nFAIL PS-276 resolver guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-276 resolver guard');
}

void main();
