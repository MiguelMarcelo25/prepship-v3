/**
 * PS-277 (slices 3/4) guard — the rate SOT is one fingerprint-stamped value; stale -> recalc.
 *
 * The staleness invariant (the heart of PS-277): the request fingerprint is the VALIDITY KEY, so
 * when weight/dims/residential change, the fingerprint changes => a saved SOT with the old fingerprint
 * is detected stale => a surface shows recalc, NEVER the stale number. Plus the SOT-writer invariants:
 * the persisted SOT is produced ONLY by the single combined funnel (finalizeBestRateWithQuote, PS-244)
 * via backfill + browse-reconcile (gated) + strict-recalc — never an independent number — and the FE
 * rate key reads the backend residential verdict (PS-276 slice 3), so the column/browser can't diverge.
 *
 *   npx tsx scripts/ps-277-sot-consistency-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  buildShippingRateRequestFingerprint,
  residentialFromRequestFingerprint,
} from '../src/services/shipping-workflow/rate-fingerprint';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. Fingerprint = validity key: input changes => fingerprint changes => SOT stale ──
const base = {
  version: 'ground-saver-v2',
  shipDateBucket: '2026-06-15',
  weightOz: 51,
  toZip: '77422',
  toCountry: 'US',
  toState: 'TX',
  residential: true as boolean,
  dimsL: 9,
  dimsW: 6,
  dimsH: 3,
};
const fp = buildShippingRateRequestFingerprint(base);
check('fingerprint is deterministic (same inputs -> same key)',
  fp === buildShippingRateRequestFingerprint({ ...base }));
check('WEIGHT change invalidates the SOT (different fingerprint)',
  fp !== buildShippingRateRequestFingerprint({ ...base, weightOz: 80 }));
check('DIMS change invalidates the SOT',
  fp !== buildShippingRateRequestFingerprint({ ...base, dimsL: 12 }) &&
    fp !== buildShippingRateRequestFingerprint({ ...base, dimsW: 8 }) &&
    fp !== buildShippingRateRequestFingerprint({ ...base, dimsH: 5 }));
check('RESIDENTIAL change invalidates the SOT (r=1 vs r=0)',
  fp !== buildShippingRateRequestFingerprint({ ...base, residential: false }));
check('ZIP change invalidates the SOT',
  fp !== buildShippingRateRequestFingerprint({ ...base, toZip: '90210' }));

// ── 2. The residential bit round-trips (FE draft key r= == backend fingerprint r=) ──
check('residential r= round-trips through the fingerprint',
  residentialFromRequestFingerprint(buildShippingRateRequestFingerprint({ ...base, residential: true })) === true &&
    residentialFromRequestFingerprint(buildShippingRateRequestFingerprint({ ...base, residential: false })) === false);

// ── 3. SOT-writer invariants: one funnel (PS-244), no independent number ──────
const browse = readFileSync('src/routes/rates.ts', 'utf8');
const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
check('browse + backfill BOTH produce the best via the single funnel finalizeBestRateWithQuote (PS-244)',
  /finalizeBestRateWithQuote\(\{/.test(browse) && /finalizeBestRateWithQuote\(\{/.test(backfill));
check('browse RECONCILES the SOT (plain browse, gated) via the awaiting-only persist owner (277.1)',
  /persistStrictRecalculateOutcome\(\{[\s\S]{0,200}decision: reconcileDecision/.test(browse) &&
    /browseSotWritebackEnabled\(\)/.test(browse));

// ── 4. The column reads the persisted SOT; the FE key reads the backend verdict (PS-276 #3) ──
// PS-317: residentialForRate moved to ./orders/best-rate/rate-request — include it so the delegation pin resolves.
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8') + readFileSync('web/src/components/Views/orders/best-rate/rate-request.ts', 'utf8');
// PS-166/PS-306/PS-258 (Wave 2): the BEST RATE column leaf cell was extracted
// VERBATIM from OrdersView into ./orders/cells/order-cells. The persisted-SOT
// read (getBestRateBaseCost / getBackendRowMoney) still owns the column money —
// just at the new leaf owner — so re-anchor the column check there.
const orderCells = readFileSync('web/src/components/Views/orders/cells/order-cells.tsx', 'utf8');
check('the BEST RATE column reads the persisted SOT (getBestRateBaseCost / getBackendRowMoney)',
  /getBestRateBaseCost\(/.test(orderCells) && /getBackendRowMoney\(/.test(orderCells));
// PS-280: the residential-verdict read moved to the shared FE rule (web/src/lib/residential-for-rate),
// which OrdersView AND RateBrowserModal now both DELEGATE to — so NO surface re-derives r= (stronger
// than before: the Rate Browser used to re-derive from legacy fields, now it forwards the verdict too).
const residentialRule = readFileSync('web/src/lib/residential-for-rate.ts', 'utf8');
check('the FE rate key defers to the backend residential verdict (PS-276 slice 3 — no surface re-derives r=)',
  /order\?\.residentialClassification \?\? order\?\.canonicalOrder\?\.recipient\?\.residentialClassification/.test(residentialRule) &&
    /return residentialForRateRule\(order\)/.test(ordersView));

check('package.json wires test:ps-277-sot-consistency',
  /test:ps-277-sot-consistency/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-277 SOT consistency guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-277 SOT consistency guard');
