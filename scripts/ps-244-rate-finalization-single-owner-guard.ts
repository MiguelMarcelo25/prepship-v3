/**
 * PS-244 guard — ONE owner for rate finalization.
 *
 * Before: the live /rates/browse producer stamped the selection key + quote snapshot INLINE,
 * while the backfill producer used finalizeBestRateWithQuote — two paths that could diverge
 * (browse omitted proofSource; the FE injected it). PS-244 routes BOTH producers through the
 * single finalizer, which returns { bestRate (with proofSource), rates (key+quote stamped),
 * rateQuoteId }. selectedRateKey/rateQuoteId stay byte-identical (shared pure fns).
 *
 * PS-419 completed the purchase-enforcement flip: the label-purchase boundary now requires
 * the backend snapshot reference and never authorizes postage from carried proof.
 *
 *   npx tsx scripts/ps-244-rate-finalization-single-owner-guard.ts
 */
import { readFileSync } from 'node:fs';

const store = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
const browse = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8');
const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── The single owner returns the full producer output ────────────────────────
check('finalizeBestRateWithQuote returns { bestRate, rates, rateQuoteId } (single owner shape)',
  /bestRate: T & \{[\s\S]{0,240}selectedRateKey: string;[\s\S]{0,160}rateQuoteId\?: string;[\s\S]{0,160}proofSource: string;[\s\S]{0,160}isComplete: boolean;/.test(store)
  && /rates: Array<Record<string, unknown> & \{[\s\S]{0,240}selectedRateKey: string;[\s\S]{0,160}rateQuoteId\?: string;[\s\S]{0,160}proofSource: string;[\s\S]{0,160}isComplete: boolean;/.test(store));
check('the owner stamps proofSource = the backend constant (backend owns it)',
  /proofSource: BACKEND_RATE_PROOF_SOURCE/.test(store) && /BACKEND_RATE_PROOF_SOURCE = 'backend_rate_response'/.test(store));
check('the owner stamps rateQuoteId and backend completeness onto each rate (the shape browse returns)',
  /const rates = rateQuoteId[\s\S]{0,700}rateQuoteId,[\s\S]{0,160}proofSource: BACKEND_RATE_PROOF_SOURCE,[\s\S]{0,160}isComplete,[\s\S]{0,320}proofSource: BACKEND_RATE_PROOF_SOURCE,[\s\S]{0,160}isComplete,/.test(store));

// ── /rates/browse PRODUCER delegates (no inline re-stamping) ──────────────────
check('browse calls the finalizer', /const finalized = await finalizeBestRateWithQuote\(\{/.test(browse));
check('browse takes responseRates + rateQuoteId from the finalizer',
  /rateQuoteId = finalized\.rateQuoteId/.test(browse) && /responseRates = finalized\.rates/.test(browse));
check('browse no longer stamps the snapshot inline (the duplicated trio is gone)',
  !/const ratesWithKeys = withSelectedRateKeys\(combinedRates\)[\s\S]{0,120}storeRateQuoteSnapshot\(\{/.test(browse));
check('browse keeps its own display-only fields on the best rate (insurance/expiry/completeness)',
  /effectiveInsuranceProvider: result\.effectiveInsuranceProvider/.test(browse) && /cacheExpiresAt: browseCacheExpiresAt/.test(browse));

// ── backfill PRODUCER delegates too ──────────────────────────────────────────
check('backfill delegates to the finalizer (destructured bestRate)',
  /const \{ bestRate: finalizedBest \} = await finalizeBestRateWithQuote\(\{/.test(backfill));

// ── PS-244 Phase 4 (Per user override unlock shipped data on 2026-06-15) ──────
// PS-419 made backend snapshot enforcement unconditional. The compatibility
// selectedRateProof field may still be transported, but it cannot authorize postage.
check('purchase boundary requires backend snapshot refs',
  /const ref = parseShippingQuoteSelectionRef\(body\.selectionRef\)/.test(store)
  && /if \(!ref\) \{[\s\S]{0,200}throwStrictRateQuoteError\('backend_rate_quote_required'\)/.test(store));
check('purchase boundary has no carried-proof fallback',
  !/snapshot_fallback|legacy_only|assertSelectedRateProofForLabelPurchase\(body\.selectedRateProof/.test(store));

const pkg = readFileSync('package.json', 'utf8');
check('package.json wires test:ps-244-rate-finalization-single-owner', /test:ps-244-rate-finalization-single-owner/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-244 rate-finalization single-owner guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-244 rate-finalization single-owner guard');
