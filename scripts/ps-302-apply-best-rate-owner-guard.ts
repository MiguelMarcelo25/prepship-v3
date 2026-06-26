/**
 * PS-302 guard — the canonical backend-owned Apply Best Rate COMMAND.
 *
 * Proves (a) the pure command owner buildApplyBestRatePatch validates an apply intent
 * as a UNIT (rate + complete dims + chosen package, with optional selected-rate-proof
 * fingerprint matching) and returns the single atomic override patch or a structured
 * error; (b) the route POST /:id/apply-best-rate exists, runs behind assertOrderEditable,
 * delegates to the owner, and persists via ONE applyOverridesPatch (not three browser
 * writes).
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no marketplace
 * calls, no Trello mutation, no shipped/cancelled mutation.
 */
import { readFileSync } from 'node:fs';
import { buildApplyBestRatePatch } from '../src/services/shipping-workflow/apply-best-rate';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

const FP = 'ps302|zip=19422|dims=8x6x6|provider=607855';
const rate = { amount: 10.79, carrierCode: 'ups', serviceCode: 'ups_ground', requestFingerprint: FP };

// 1. Valid apply → ok; one patch carrying dims + package + label + weight.
const ok = buildApplyBestRatePatch({ bestRateJson: rate, dimsLabel: '8x6x6', selectedPid: 42, weightOz: 16 });
check('valid: ok', ok.ok === true, ok);
if (ok.ok) {
  check('valid: patch has parsed dims', ok.patch.rateDimsL === 8 && ok.patch.rateDimsW === 6 && ok.patch.rateDimsH === 6, ok.patch);
  check('valid: patch has selectedPid', ok.patch.selectedPid === 42, ok.patch);
  check('valid: patch has bestRateDims label', ok.patch.bestRateDims === '8x6x6', ok.patch);
  check('valid: patch carries weight', ok.patch.rateWeightOz === 16, ok.patch);
  check('valid: patch carries the rate', ok.patch.bestRateJson === rate, ok.patch);
}

// 2. Missing rate → missing_rate.
const noRate = buildApplyBestRatePatch({ bestRateJson: null, dimsLabel: '8x6x6', selectedPid: 42 });
check('missing-rate: code', noRate.ok === false && noRate.code === 'missing_rate', noRate);

// 3. Incomplete dims → missing_dims.
const noDims = buildApplyBestRatePatch({ bestRateJson: rate, dimsLabel: '8x6', selectedPid: 42 });
check('missing-dims: code', noDims.ok === false && noDims.code === 'missing_dims', noDims);
const zeroDims = buildApplyBestRatePatch({ bestRateJson: rate, dimsLabel: '0x6x6', selectedPid: 42 });
check('zero-dims rejected', zeroDims.ok === false && zeroDims.code === 'missing_dims', zeroDims);

// 4. Missing package → missing_package.
const noPid = buildApplyBestRatePatch({ bestRateJson: rate, dimsLabel: '8x6x6', selectedPid: null });
check('missing-package: code', noPid.ok === false && noPid.code === 'missing_package', noPid);

// 5. Fingerprint proof: mismatch rejected, match accepted, absent-on-rate tolerated.
const mismatch = buildApplyBestRatePatch({ bestRateJson: rate, dimsLabel: '8x6x6', selectedPid: 42, currentRequestFingerprint: 'different|fp' });
check('fingerprint mismatch rejected', mismatch.ok === false && mismatch.code === 'fingerprint_mismatch', mismatch);
const match = buildApplyBestRatePatch({ bestRateJson: rate, dimsLabel: '8x6x6', selectedPid: 42, currentRequestFingerprint: FP });
check('fingerprint match accepted', match.ok === true, match);
const noFpOnRate = buildApplyBestRatePatch({ bestRateJson: { amount: 5, carrierCode: 'usps' }, dimsLabel: '8x6x6', selectedPid: 42, currentRequestFingerprint: FP });
check('fingerprint absent on rate is tolerated', noFpOnRate.ok === true, noFpOnRate);

// 6. ROUTE wiring — backend owns the command; one atomic persist behind the lock.
const ordersRoute = read('src/routes/orders.ts');
check('orders route imports the apply-best-rate owner',
  /import \{[^}]*buildApplyBestRatePatch[^}]*\} from '\.\.\/services\/shipping-workflow\/apply-best-rate'/.test(ordersRoute));
check('POST /:id/apply-best-rate route exists',
  /'\/:id\{\[0-9\]\+\}\/apply-best-rate'/.test(ordersRoute));

// Slice the apply-best-rate handler (from its route path to the next route) and assert
// it runs behind assertOrderEditable, delegates to the owner, and does ONE persist.
const applyStart = ordersRoute.indexOf("'/:id{[0-9]+}/apply-best-rate'");
const applyEnd = ordersRoute.indexOf("'/:id{[0-9]+}/selected-package-id'", applyStart);
const handler = applyStart >= 0 && applyEnd > applyStart ? ordersRoute.slice(applyStart, applyEnd) : '';
check('apply handler guards with assertOrderEditable', /assertOrderEditable\(c, id\)/.test(handler));
check('apply handler delegates to buildApplyBestRatePatch', /buildApplyBestRatePatch\(\{/.test(handler));
check('apply handler persists via exactly ONE applyOverridesPatch (atomic, not 3 writes)',
  (handler.match(/applyOverridesPatch\(/g)?.length ?? 0) === 1, handler.match(/applyOverridesPatch\(/g));
check('apply handler enforces rate eligibility before persisting',
  /shippingRateEligibilityReason\(/.test(handler));

if (failures > 0) {
  console.error(`\nPS-302 apply-best-rate owner guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-302 apply-best-rate owner guard passed.');
