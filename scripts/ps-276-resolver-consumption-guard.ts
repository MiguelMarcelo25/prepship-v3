/**
 * PS-276 (slice 2b-2a) guard — the classifier path CONSUMES resolver evidence (addressValidation /
 * providerMarker), end to end, and is INERT until a caller supplies it.
 *
 * Proves: (1) the shared evidence owner merges resolver evidence (buildResidentialEvidenceFromOrder
 * { resolved }) and carries it into the RateInput (residentialEvidenceRateInput); (2) fed to the
 * canonical classifier, an explicit USPS business marker flips the verdict to commercial (tier 4 now
 * consumed) — and with NO resolver evidence the verdict is unchanged (residential); (3) the rate +
 * DTO classifier call-sites pass addressValidation/providerMarker through.
 *
 *   npx tsx scripts/ps-276-resolver-consumption-guard.ts
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

const baseShipTo = { postalCode: '77422', country: 'US' };
function verdict(rateInputFields: Record<string, unknown>): boolean {
  return residentialForShipping(
    classifyShippingAddress({ shipTo: baseShipTo, ...rateInputFields }),
  );
}

// ── 1. Owner merges + carries resolver evidence ───────────────────────────────
const evCommercial = buildResidentialEvidenceFromOrder({
  rawShipTo: {},
  manualOverrideResidential: null,
  resolved: { addressValidation: { business: 'Y', dpvConfirmation: 'Y', zipPlus4: null, carrierRoute: null } },
});
check('resolved addressValidation merged into evidence', evCommercial.addressValidation?.business === 'Y');
const riCommercial = residentialEvidenceRateInput(evCommercial);
check('rate input carries addressValidation through the owner',
  (riCommercial.addressValidation as { business?: unknown } | null | undefined)?.business === 'Y');

// ── 2. End-to-end: the classifier now CONSUMES the resolver evidence ──────────
check('USPS business=Y (no override/source) -> classifier verdict COMMERCIAL (tier 4 consumed)',
  verdict(riCommercial as Record<string, unknown>) === false);
const evResidential = buildResidentialEvidenceFromOrder({
  rawShipTo: {},
  manualOverrideResidential: null,
  resolved: { addressValidation: { business: 'N' } },
});
check('USPS business=N -> classifier verdict RESIDENTIAL',
  verdict(residentialEvidenceRateInput(evResidential) as Record<string, unknown>) === true);

// ── 3. INERT: no resolver evidence -> unchanged (residential) ─────────────────
const evNone = buildResidentialEvidenceFromOrder({ rawShipTo: {}, manualOverrideResidential: null });
check('no resolved -> no addressValidation on the evidence (inert)', !evNone.addressValidation);
check('no resolver evidence -> verdict RESIDENTIAL (behavior unchanged)',
  verdict(residentialEvidenceRateInput(evNone) as Record<string, unknown>) === true);
// Money-safe: an ambiguous business marker must NOT flip commercial.
const evAmbiguous = buildResidentialEvidenceFromOrder({
  rawShipTo: {}, manualOverrideResidential: null, resolved: { addressValidation: { business: 'MIXED' } },
});
check('ambiguous addressValidation business -> still residential (money-safe)',
  verdict(residentialEvidenceRateInput(evAmbiguous) as Record<string, unknown>) === true);

// ── 4. The rate + DTO classifier call-sites pass the evidence through ──────────
const rates = readFileSync('src/services/rates.ts', 'utf8');
check('RateInput carries addressValidation + providerMarker',
  /addressValidation\?: \{ business\?:/.test(rates) && /providerMarker\?: \{ classification\?:/.test(rates));
check('classifyRateInputResidential passes addressValidation + providerMarker to the classifier',
  /addressValidation: input\.addressValidation \?\? undefined/.test(rates) &&
    /providerMarker: input\.providerMarker \?\? undefined/.test(rates));
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const orders = readFileSync('src/services/orders-read-model.ts', 'utf8');
check('buildCanonicalOrderModel threads resolved evidence into its classifier call',
  /resolved: resolvedResidential \?\? null/.test(orders) &&
    /addressValidation: residentialEvidence\.addressValidation \?\? undefined/.test(orders) &&
    /from '\.\.\/services\/orders-read-model'/.test(ordersRoute));

check('package.json wires test:ps-276-resolver-consumption',
  /test:ps-276-resolver-consumption/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-276 resolver-consumption guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-276 resolver-consumption guard');
