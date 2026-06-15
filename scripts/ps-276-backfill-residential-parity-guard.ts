/**
 * PS-276 (slice 1) guard — backfill residential parity (the #1585 residential fix).
 *
 * Before: /rates/browse loaded order_overrides.residential (the operator's manual override)
 * and fed it to the classifier as manualOverrideResidential, but rates-backfill sent only the
 * lone raw.shipTo.residential. The classifier reads manualOverrideResidential as a SEPARATE,
 * higher-priority tier than the source flag — so a manual COMMERCIAL override was honored by
 * the live Rate Browser yet silently dropped by the persisted BEST RATE column the backfill
 * writes (#1585: $13.00 column vs $10.79 browser).
 *
 * This pins: (1) the shared evidence owner maps fields correctly; (2) a manual commercial
 * override BEATS a residential source flag through the real classifier (the mechanism that was
 * being lost); (3) BOTH browse and backfill build the rate input via the shared owner; (4)
 * backfill no longer uses the lone `residential: raw.shipTo?.residential`.
 *
 *   npx tsx scripts/ps-276-backfill-residential-parity-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  buildResidentialEvidenceFromOrder,
  residentialEvidenceRateInput,
} from '../src/services/shipping-workflow/residential-evidence';
import {
  classifyShippingAddress,
  residentialForShipping,
} from '../src/services/shipping-workflow/address-classification';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const shipTo = { name: null, company: null, city: 'Brazoria', state: 'TX', postalCode: '77422', country: 'US' };
function resolveResidential(ev: ReturnType<typeof buildResidentialEvidenceFromOrder>): boolean {
  const result = classifyShippingAddress({
    orderId: undefined,
    clientId: null,
    storeId: null,
    shipTo: { ...shipTo, company: ev.toCompany, name: ev.toName },
    manualOverrideResidential: ev.manualOverrideResidential,
    sourceResidential: ev.sourceResidential,
  });
  return residentialForShipping(result);
}

// ── 1. Evidence owner maps fields (only real booleans count) ──────────────────
const ev = buildResidentialEvidenceFromOrder({
  rawShipTo: { residential: true, company: 'ACME LLC' },
  manualOverrideResidential: false,
  shipToName: 'Jane Doe',
});
check('manual override boolean -> manualOverrideResidential', ev.manualOverrideResidential === false);
check('raw.shipTo.residential -> sourceResidential', ev.sourceResidential === true);
check('raw.shipTo.company -> toCompany', ev.toCompany === 'ACME LLC');
check('shipToName -> toName', ev.toName === 'Jane Doe');
const evNoise = buildResidentialEvidenceFromOrder({ rawShipTo: { residential: 'yes' }, manualOverrideResidential: 'no' });
check('non-boolean override -> null (no guess)', evNoise.manualOverrideResidential === null);
check('non-boolean source -> null (no guess)', evNoise.sourceResidential === null);
check('null rawShipTo is safe', buildResidentialEvidenceFromOrder({ rawShipTo: null, manualOverrideResidential: null }).sourceResidential === null);

// ── 2. residentialEvidenceRateInput drops the collapsed boolean ───────────────
const ri = residentialEvidenceRateInput(ev);
check('rate input sets residential: undefined (collapsed boolean dropped)', ri.residential === undefined);
check('rate input carries manualOverrideResidential', ri.manualOverrideResidential === false);
check('rate input carries sourceResidential', ri.sourceResidential === true);
check('rate input keeps toName only when caller has none', residentialEvidenceRateInput(ev, 'Existing').toName === undefined);

// ── 3. THE #1585 MECHANISM: a manual commercial override beats a residential source ──
const commercialOverride = buildResidentialEvidenceFromOrder({
  rawShipTo: { residential: true }, // source says residential
  manualOverrideResidential: false, // operator marked commercial
});
check('manual COMMERCIAL override beats source residential -> commercial', resolveResidential(commercialOverride) === false);
const noOverride = buildResidentialEvidenceFromOrder({ rawShipTo: { residential: true }, manualOverrideResidential: null });
check('source residential with NO override -> residential', resolveResidential(noOverride) === true);
// money-safe: a bare company-name guess (heuristic) must NOT flip to commercial
const heuristicOnly = buildResidentialEvidenceFromOrder({ rawShipTo: { company: 'ACME LLC' }, manualOverrideResidential: null });
check('company-name heuristic alone stays residential (money-safe)', resolveResidential(heuristicOnly) === true);

// ── 4. BOTH producers build the rate input via the shared owner ───────────────
const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
const browse = readFileSync('src/routes/rates.ts', 'utf8');
check('backfill SELECTs the manual residential override (orderOverrides.residential)',
  /residentialOverride: orderOverrides\.residential/.test(backfill));
check('backfill builds evidence via the shared owner',
  /buildResidentialEvidenceFromOrder\(\{/.test(backfill) && /residentialEvidenceRateInput\(residentialEvidence\)/.test(backfill));
check('backfill no longer uses the lone raw.shipTo.residential in the rate input',
  !/residential: raw\.shipTo\?\.residential \?\? undefined/.test(backfill));
check('browse routes through the SAME shared owner (single owner, no drift)',
  /buildResidentialEvidenceFromOrder\(\{/.test(browse) && /residentialEvidenceRateInput\(residentialEvidence, rest\.toName\)/.test(browse));

// ── 5. package.json wires the guard ───────────────────────────────────────────
const pkg = readFileSync('package.json', 'utf8');
check('package.json wires test:ps-276-backfill-residential-parity',
  /test:ps-276-backfill-residential-parity/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-276 backfill residential parity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-276 backfill residential parity guard');
