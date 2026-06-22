/**
 * PS-302 — REAL EXECUTION test for the backend "Apply Best Rate" command builder.
 *
 * ps-302-apply-best-rate-owner-guard regexes the module's shape; this test EXECUTES
 * buildApplyBestRatePatch and asserts its validation contract as a UNIT — the rule that the
 * thin-client apply delegates to (one intent → one atomic order_overrides patch, or a
 * structured error). A regression in the validation ORDER, the fingerprint no-stale-buy gate,
 * dims parsing, or the weight-conditional patch would pass the regex guard but fail here.
 *
 * Pure + deterministic (no I/O). Run: npm run test:ps-302-apply-best-rate-behavior
 */
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

const RATE = { carrierCode: 'ups', serviceCode: 'ups_ground', requestFingerprint: 'fp-A' };

// 1. Required-input gates, in declaration order (rate → dims → package).
check('missing rate → missing_rate',
  buildApplyBestRatePatch({ bestRateJson: null, dimsLabel: '10x8x6', selectedPid: 7 }) // eslint-disable-line
    .ok === false &&
  (buildApplyBestRatePatch({ bestRateJson: null, dimsLabel: '10x8x6', selectedPid: 7 }) as any).code === 'missing_rate');
check('missing dims → missing_dims',
  (buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: null, selectedPid: 7 }) as any).code === 'missing_dims');
check('unparseable dims → missing_dims',
  (buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: '10x8', selectedPid: 7 }) as any).code === 'missing_dims' &&
  (buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: '0x8x6', selectedPid: 7 }) as any).code === 'missing_dims' &&
  (buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: 'axbxc', selectedPid: 7 }) as any).code === 'missing_dims');
check('missing package → missing_package',
  (buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: '10x8x6', selectedPid: null }) as any).code === 'missing_package');
check('validation order: missing everything reports missing_rate first',
  (buildApplyBestRatePatch({ bestRateJson: null, dimsLabel: null, selectedPid: null }) as any).code === 'missing_rate');

// 2. Fingerprint no-stale-buy gate (only enforced when BOTH a wanted fp and a rate fp exist).
check('fingerprint mismatch → fingerprint_mismatch',
  (buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: '10x8x6', selectedPid: 7, currentRequestFingerprint: 'fp-B' }) as any).code === 'fingerprint_mismatch');
check('fingerprint match → ok',
  buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: '10x8x6', selectedPid: 7, currentRequestFingerprint: 'fp-A' }).ok === true);
check('wanted fp but rate carries none → ok (no false stale rejection)',
  buildApplyBestRatePatch({ bestRateJson: { carrierCode: 'ups' }, dimsLabel: '10x8x6', selectedPid: 7, currentRequestFingerprint: 'fp-B' }).ok === true);

// 3. Happy-path patch shape — the single atomic override the route persists.
const happy = buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: '10x8x6', selectedPid: 7 });
check('happy path → ok', happy.ok === true);
if (happy.ok) {
  check('patch returns the rate payload verbatim (route canonicalizes it)', happy.patch.bestRateJson === RATE);
  check('patch carries the chosen package', happy.patch.selectedPid === 7);
  check('patch normalizes the dims label', happy.patch.bestRateDims === '10x8x6');
  check('patch splits dims into L/W/H', happy.patch.rateDimsL === 10 && happy.patch.rateDimsW === 8 && happy.patch.rateDimsH === 6);
  check('patch omits rateWeightOz when no weight supplied', happy.patch.rateWeightOz === undefined);
}

// 4. Weight is patched only when positive.
const weighed = buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: '10x8x6', selectedPid: 7, weightOz: 12.5 });
check('positive weightOz → included in patch', weighed.ok && (weighed as any).patch.rateWeightOz === 12.5);
const zeroWeight = buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: '10x8x6', selectedPid: 7, weightOz: 0 });
check('zero weightOz → omitted from patch', zeroWeight.ok && (zeroWeight as any).patch.rateWeightOz === undefined);

// 5. Dims parsing is whitespace/case tolerant.
const spaced = buildApplyBestRatePatch({ bestRateJson: RATE, dimsLabel: ' 10 X 8 X 6 ', selectedPid: 7 });
check('dims parsing tolerates spaces + uppercase X', spaced.ok && (spaced as any).patch.bestRateDims === '10x8x6');

if (failures > 0) {
  console.error(`\nPS-302 apply-best-rate behavior test FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-302 apply-best-rate behavior test passed.');
