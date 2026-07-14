/**
 * PS-302 guard — the canonical backend-owned Apply Best Rate COMMAND.
 *
 * Proves (a) the pure command owner buildApplyBestRatePatch validates an apply intent
 * as a UNIT (rate + complete dims + chosen package, with optional selected-rate-proof
 * fingerprint matching) and returns the single atomic override patch or a structured
 * error; (b) the route POST /:id/apply-best-rate exists, runs behind assertOrderEditable,
 * delegates to the owner, and persists via ONE applyOrderOverridesPatch (not three browser
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

// 6. ROUTE wiring — the lock stays in the HTTP boundary; business command lives in its service.
const ordersRoute = read('src/routes/orders.ts');
const commandOwner = read('src/services/orders-overrides-command.ts');
check('orders route imports the apply-best-rate command owner',
  /import \{[^}]*applyBestRateForOrder[^}]*\} from '\.\.\/services\/orders-overrides-command'/.test(ordersRoute));
check('POST /:id/apply-best-rate route exists',
  /'\/:id\{\[0-9\]\+\}\/apply-best-rate'/.test(ordersRoute));

const applyStart = ordersRoute.indexOf("'/:id{[0-9]+}/apply-best-rate'");
const applyEnd = ordersRoute.indexOf("'/:id{[0-9]+}/selected-package-id'", applyStart);
const handler = applyStart >= 0 && applyEnd > applyStart ? ordersRoute.slice(applyStart, applyEnd) : '';
check('apply handler guards with assertOrderEditable before delegation',
  handler.indexOf('assertOrderEditable(c, id)') >= 0 &&
  handler.indexOf('assertOrderEditable(c, id)') < handler.indexOf('applyBestRateForOrder('));
check('apply handler delegates to the command owner', /applyBestRateForOrder\(id, \{/.test(handler));
check('apply handler contains no DB persistence or rate-policy implementation',
  !/db\.|buildApplyBestRatePatch\(|applyOrderOverridesPatch\(|houseTupleStatus\(|loadRateQuoteSnapshot\(/.test(handler));

const commandStart = commandOwner.indexOf('export async function applyBestRateForOrder(');
const commandEnd = commandOwner.indexOf('export async function saveBestRateForOrder(', commandStart);
const command = commandStart >= 0 && commandEnd > commandStart
  ? commandOwner.slice(commandStart, commandEnd)
  : '';
check('command owner builds one atomic apply patch', /buildApplyBestRatePatch\(\{/.test(command));
check('command owner persists via exactly ONE override command',
  (command.match(/applyOrderOverridesPatch\(/g)?.length ?? 0) === 1);
check('command owner enforces eligibility before persisting',
  /shippingRateEligibilityReason\(/.test(command));
check('command owner finalizes backend quote proof before applying',
  /finalizeAppliedBestRateFromSnapshot\(\{/.test(command));

if (failures > 0) {
  console.error(`\nPS-302 apply-best-rate owner guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-302 apply-best-rate owner guard passed.');
