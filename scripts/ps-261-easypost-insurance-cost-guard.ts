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
import { parseEasyPostInsuranceCost } from '../src/connectors/carrier/easypost-insurance-fee';

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
// Repointed 2026-08-05: `account.provider` became a plain `provider` parameter when the
// pricing step was extracted into applyDirectRatePricing(rates, markups, provider,
// shippingOptions). Same three conditions, same order; only the binding moved. Allow
// either spelling so a future extraction does not re-break this, and keep the ordering
// requirement, which is the part that matters: the premium is applied ONLY for EasyPost,
// ONLY when insurance is on, and ONLY when there is an insured value.
check('estimate applied only to easypost provider when insured',
  /normalizeProviderKey\((?:account\.)?provider\) === 'easypost'[\s\S]{0,160}insuranceProvider !== 'none'[\s\S]{0,120}insuredValue/.test(rates));
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

// ── easypost-insurance-fee.ts: PURE parser maps the bought-shipment fees to dollars ──
// A representative EasyPost bought-shipment payload: the InsuranceFee line is what was billed.
check('fees[] InsuranceFee maps to its dollar amount',
  parseEasyPostInsuranceCost({
    fees: [
      { type: 'LabelFee', amount: '0.00' },
      { type: 'PostageFee', amount: '7.10' },
      { type: 'InsuranceFee', amount: '0.50' },
    ],
  }) === 0.5);
check('InsuranceFee match is case-insensitive on type',
  parseEasyPostInsuranceCost({ fees: [{ type: 'insurancefee', amount: '1.27' }] }) === 1.27);
check('a numeric (not String) InsuranceFee amount is tolerated',
  parseEasyPostInsuranceCost({ fees: [{ type: 'InsuranceFee', amount: 2 }] }) === 2);
check('the InsuranceFee dollar amount is rounded to cents',
  parseEasyPostInsuranceCost({ fees: [{ type: 'InsuranceFee', amount: '0.505' }] }) === 0.51);
check('no fees[] -> falls back to the shipment `insurance` value',
  parseEasyPostInsuranceCost({ insurance: '100.00', fees: [] }) === 100);
check('fees[] InsuranceFee wins over the `insurance` fallback',
  parseEasyPostInsuranceCost({ insurance: '100.00', fees: [{ type: 'InsuranceFee', amount: '0.50' }] }) === 0.5);

// ── REGRESSION-PIN the #1502 false-confirmation class: unpriced $0 is NOT confirmed ──
// The parser returns null (NOT 0) for any absent / zero / non-finite insurance line, so a
// downstream consumer can never mistake an unpriced label for a confirmed $0 insurance cost.
check('no insurance line at all -> null (never a confirmed $0)',
  parseEasyPostInsuranceCost({ fees: [{ type: 'PostageFee', amount: '7.10' }] }) === null);
check('a $0.00 InsuranceFee -> null (unpriced, NOT confirmed $0)',
  parseEasyPostInsuranceCost({ fees: [{ type: 'InsuranceFee', amount: '0.00' }] }) === null);
check('insurance="0" / empty / missing -> null',
  parseEasyPostInsuranceCost({ insurance: '0' }) === null
  && parseEasyPostInsuranceCost({ insurance: '' }) === null
  && parseEasyPostInsuranceCost({}) === null);
check('a non-object / null / array purchase response -> null (no throw)',
  parseEasyPostInsuranceCost(null) === null
  && parseEasyPostInsuranceCost(undefined) === null
  && parseEasyPostInsuranceCost('nope') === null);
check('a non-numeric amount -> null (never coerced to 0)',
  parseEasyPostInsuranceCost({ fees: [{ type: 'InsuranceFee', amount: 'free' }] }) === null);

// ── easypost.ts connector: the createLabel RETURN now carries insuranceCost (read-only) ──
const easypost = read('src/connectors/carrier/easypost.ts');
check('easypost.ts imports the pure parser', easypost.includes('parseEasyPostInsuranceCost'));
check('createLabel return TYPE declares insuranceCost', /insuranceCost\?: number \| null;/.test(easypost));
check('createLabel return VALUE wires parseEasyPostInsuranceCost(purchased)',
  /insuranceCost: parseEasyPostInsuranceCost\(purchased\),/.test(easypost));
check('postage `cost` is unchanged (still the selected/best rate, NOT insurance)',
  /cost: Number\(purchased\.selected_rate\?\.rate \?\? rate\.rate \?\? 0\),/.test(easypost));

// ── PS-261 BILLING WRITE: the EasyPost insurance fee is now CONSUMED + billed (not discarded) ──
// Previously createLabelEasyPost discarded its parsed fee. The billing write threads it onto
// created.insuranceCost (labels-direct.ts) and persistCreatedLabel bills it as otherCost with
// insuranceProvenance='easypost'. Defensive: an unpriced label (parser -> null/0) still persists $0.
const labelsDirect = read('src/services/labels-direct.ts');
check('labels-direct threads the connector insuranceCost onto created.insuranceCost (billed, not discarded)',
  /insuranceCost: Number\(resultRecord\.insuranceCost \?\? 0\) \|\| 0,/.test(labelsDirect));
check('labels-direct cites the PS-261 billing-write override',
  /PS-261 \(Per user override unlock shipped data on 2026-06-17\)/.test(labelsDirect));

const labels = read('src/services/labels.ts');
check('persistCreatedLabel detects the EasyPost-billed insurance (identity-first via carrier code)',
  /const isEasyPostBilled\s*=[\s\S]{0,160}=== 'easypost'/.test(labels));
check("persistCreatedLabel bills EasyPost insurance with provenance 'easypost' (not shipstation/0)",
  /isEasyPostBilled\s*\n?\s*\?\s*'easypost'/.test(labels));
check('the EasyPost provenance only bills when present (reportedInsuranceCost > 0 gate)',
  /reportedInsuranceCost > 0 &&[\s\S]{0,120}=== 'easypost'/.test(labels));

// insurance-cost.ts: the new 'easypost' provenance member exists for the persist write to use.
check("insurance-cost.ts declares the 'easypost' InsuranceCostProvenance member",
  /\|\s*'easypost'/.test(insuranceCost));

const pkg = read('package.json');
check('package.json wires test:ps-261-easypost-insurance-cost', /test:ps-261-easypost-insurance-cost/.test(pkg));
check('package.json wires test:ps-274-shipp-insurance-certainty', /test:ps-274-shipp-insurance-certainty/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-261 EasyPost insurance-cost guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-261 EasyPost insurance-cost guard');
