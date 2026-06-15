/**
 * PS-261 (slice 1) guard — EasyPost insurance is priced at rate time; no provider is falsely
 * confirmed at $0.
 *
 * Direct-carrier rates (easypost/shipp/walmart_shipping) are assembled by
 * getDirectCarrierRatesForRateInput and merged into the combined universe AFTER the
 * ShipStation enrichRatesWithInsuranceCost pass (rates-combined.ts), so they never get an
 * insurance premium from that enricher. An insured EasyPost rate therefore carried
 * insurance_amount=0 and won the combined cheapest pick unfairly. This slice:
 *   (1) attaches a best-effort EasyPost insurance estimate (max $0.50, 1% of value) to insured
 *       EasyPost rates in the direct path so they're ranked/displayed fairly; and
 *   (2) flips resolveRateInsurancePremium's non-ParcelGuard $0 fallback from confirmed:true to
 *       confirmed:false, so an unhandled provider (easypost, the dead 'shipsurance', any future
 *       value) is never FALSELY confirmed as carrying $0 insurance.
 *
 * Accurate post-purchase billing (the EasyPost connector reporting its real fee) is a
 * deferred source-of-truth slice — out of scope here.
 *
 *   npx tsx scripts/ps-261-easypost-insurance-cost-guard.ts
 */
import { readFileSync } from 'node:fs';
import { easyPostScheduledPremium } from '../src/services/shipping-workflow/insurance-cost';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── easyPostScheduledPremium: max($0.50, 1% of insured value) ─────────────────
check('$100 insured -> $1.00 (1% dominates the $0.50 floor)', easyPostScheduledPremium(100) === 1.0);
check('$30 insured -> $0.50 floor (1% = $0.30 < floor)', easyPostScheduledPremium(30) === 0.5);
check('$1000 insured -> $10.00 (1%)', easyPostScheduledPremium(1000) === 10.0);
check('$0 / negative / non-finite -> null (never priced, never blocks)',
  easyPostScheduledPremium(0) === null && easyPostScheduledPremium(-5) === null && easyPostScheduledPremium(NaN) === null);
check('premium is rounded to cents', easyPostScheduledPremium(33.33) === 0.5 && easyPostScheduledPremium(133) === 1.33);

// ── rates.ts: insured EasyPost direct rates get the estimate (not $0) ──────────
const rates = read('src/services/rates.ts');
check('rates.ts imports easyPostScheduledPremium', rates.includes('easyPostScheduledPremium'));
check('estimate applied only to easypost provider when insured',
  /normalizeProviderKey\(account\.provider\) === 'easypost'[\s\S]{0,160}insuranceProvider !== 'none'[\s\S]{0,120}insuredValue/.test(rates));
check('estimate overwrites the direct rate insurance_amount (was 0)',
  /insurance_amount: \{ amount: easyPostPremium/.test(rates));

// ── insurance-cost.ts: no FALSE $0 confirmation for unhandled providers ───────
const insuranceCost = read('src/services/shipping-workflow/insurance-cost.ts');
check('the non-ParcelGuard $0 fallback is now confirmed:false',
  /provenance: 'shipstation_estimate',\s*\n\s*confirmed: false,/.test(insuranceCost));
check('no falsely-confirmed $0 fallback (amount:0 + shipstation_estimate must not be confirmed:true)',
  !/amount: 0,\s*\n\s*provenance: 'shipstation_estimate',\s*\n\s*confirmed: true,/.test(insuranceCost));
check('a POSITIVE shipstation_estimate stays confirmed:true (real estimate trusted, unchanged)',
  /amount: Number\(estimateAmount[\s\S]{0,120}provenance: 'shipstation_estimate',\s*\n\s*confirmed: true,/.test(insuranceCost));
check('the genuine carrier free-tier $0 stays confirmed (unchanged)',
  /provenance: 'carrier_declared_value',\s*\n\s*confirmed: true,/.test(insuranceCost));

const pkg = read('package.json');
check('package.json wires test:ps-261-easypost-insurance-cost', /test:ps-261-easypost-insurance-cost/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-261 EasyPost insurance-cost guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-261 EasyPost insurance-cost guard');
