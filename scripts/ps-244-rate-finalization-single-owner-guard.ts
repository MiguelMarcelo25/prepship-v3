/**
 * PS-244 guard — ONE owner for rate finalization.
 *
 * Before: the live /rates/browse producer stamped the selection key + quote snapshot INLINE,
 * while the backfill producer used finalizeBestRateWithQuote — two paths that could diverge
 * (browse omitted proofSource; the FE injected it). PS-244 routes BOTH producers through the
 * single finalizer, which returns { bestRate (with proofSource), rates (key+quote stamped),
 * rateQuoteId }. selectedRateKey/rateQuoteId stay byte-identical (shared pure fns).
 *
 * DEFERRED (locked, gated): the purchase-ENFORCEMENT flip (snapshot-only) — the label-purchase
 * boundary stays dual-path (snapshot preferred, legacy selectedRateProof fallback). This guard
 * pins that the flip did NOT happen.
 *
 *   npx tsx scripts/ps-244-rate-finalization-single-owner-guard.ts
 */
import { readFileSync } from 'node:fs';

const store = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
const browse = readFileSync('src/routes/rates.ts', 'utf8');
const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── The single owner returns the full producer output ────────────────────────
check('finalizeBestRateWithQuote returns { bestRate, rates, rateQuoteId } (single owner shape)',
  /bestRate: T & \{ selectedRateKey: string; rateQuoteId\?: string; proofSource: string \}/.test(store)
  && /rates: Array<Record<string, unknown> & \{ selectedRateKey: string; rateQuoteId\?: string \}>/.test(store));
check('the owner stamps proofSource = the backend constant (backend owns it)',
  /proofSource: BACKEND_RATE_PROOF_SOURCE/.test(store) && /BACKEND_RATE_PROOF_SOURCE = 'backend_rate_response'/.test(store));
check('the owner stamps rateQuoteId onto each rate (the shape browse returned inline)',
  /ratesWithKeys\.map\(\(rate\) => \(\{ \.\.\.rate, rateQuoteId \}\)\)/.test(store));

// ── /rates/browse PRODUCER delegates (no inline re-stamping) ──────────────────
check('browse calls the finalizer', /const finalized = await finalizeBestRateWithQuote\(\{/.test(browse));
check('browse takes responseRates + rateQuoteId from the finalizer',
  /responseRates = finalized\.rates/.test(browse) && /rateQuoteId = finalized\.rateQuoteId/.test(browse));
check('browse no longer stamps the snapshot inline (the duplicated trio is gone)',
  !/const ratesWithKeys = withSelectedRateKeys\(combinedRates\)[\s\S]{0,120}storeRateQuoteSnapshot\(\{/.test(browse));
check('browse keeps its own display-only fields on the best rate (insurance/expiry/completeness)',
  /effectiveInsuranceProvider: result\.effectiveInsuranceProvider/.test(browse) && /cacheExpiresAt: browseCacheExpiresAt/.test(browse));

// ── backfill PRODUCER delegates too ──────────────────────────────────────────
check('backfill delegates to the finalizer (destructured bestRate)',
  /const \{ bestRate: finalizedBest \} = await finalizeBestRateWithQuote\(\{/.test(backfill));

// ── DEFERRED: the purchase-enforcement flip did NOT happen ────────────────────
check('purchase boundary keeps the legacy selectedRateProof FALLBACK (flip deferred, not done)',
  /falls back to the legacy carried selectedRateProof/i.test(store) || /FALL BACK to the legacy carried proof/i.test(store));

const pkg = readFileSync('package.json', 'utf8');
check('package.json wires test:ps-244-rate-finalization-single-owner', /test:ps-244-rate-finalization-single-owner/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-244 rate-finalization single-owner guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-244 rate-finalization single-owner guard');
