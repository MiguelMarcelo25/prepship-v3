/**
 * PS-174 (Phase 2) guard — every backend-finalized best rate carries the quote ref.
 *
 * Phase 2's snapshot/key primitive was largely built by PS-105 (+ PS-198 FE
 * pass-through, + PS-183 backend expiry): /rates/browse stamps rateQuoteId +
 * selectedRateKey on every rate, and the recalculate path persists them via the
 * browse → FE pass-through chain. The REMAINING gap this closes: the server-side
 * rates-backfill persisted best rates WITHOUT the ref, so a reloaded "fresh"
 * saved rate could not be snapshot-purchased until someone re-browsed.
 *
 * Pins:
 *   1. The snapshot store exports ONE finalizer (finalizeBestRateWithQuote) that
 *      reuses the canonical pieces (withSelectedRateKeys + storeRateQuoteSnapshot
 *      + selectedRateOpaqueKey) and the single backend proof-source constant.
 *   2. rates-backfill persists THROUGH the finalizer (bestWithMetadata spreads
 *      finalizedBest), keeping its existing metadata fields.
 *   3. The legacy selectedRateProof fallback at the purchase boundary is intact
 *      (Phase 2 adds NO enforcement — that is Phase 4).
 *   4. /rates/browse's own stamping is untouched (ps-105 pins remain the deep
 *      authority; this just cross-checks the anchors still exist).
 *
 *   npx tsx scripts/ps-174-quote-key-consolidation-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const store = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
check('snapshot store exports the single finalizer',
  /export async function finalizeBestRateWithQuote/.test(store));
check('finalizer reuses the canonical pieces (keys + snapshot + opaque key)',
  (() => {
    const start = store.indexOf('export async function finalizeBestRateWithQuote');
    // The multi-line input type closes with a column-0 '}' — anchor on the next
    // export instead of brace matching.
    const end = store.indexOf('\nexport ', start + 10);
    const block = store.slice(start, end > 0 ? end : start + 2000);
    return /withSelectedRateKeys\(input\.rates\)/.test(block) &&
      /storeRateQuoteSnapshot\(\{/.test(block) &&
      /selectedRateKey: selectedRateOpaqueKey\(input\.bestRate\)/.test(block);
  })());
check('single backend proof-source constant, stamped by the finalizer',
  /export const BACKEND_RATE_PROOF_SOURCE = 'backend_rate_response'/.test(store) &&
  /proofSource: BACKEND_RATE_PROOF_SOURCE/.test(store));
check('finalizer omits the ref when no snapshot id (half-ref never invented as full)',
  /\.\.\.\(rateQuoteId \? \{ rateQuoteId \} : \{\}\)/.test(store));

const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
// PS-203 (stage 4): the backfill now persists the COMBINED winner — the
// fingerprint is the combined request key (SS + direct), not the SS-only one.
check('rates-backfill persists THROUGH the finalizer (PS-244 single owner; destructured bestRate)',
  /const \{ bestRate: finalizedBest \} = await finalizeBestRateWithQuote\(\{/.test(backfill) &&
  /\.\.\.finalizedBest,\s*\n\s*requestFingerprint: combined\.combinedRequestKey/.test(backfill));
check('backfill keeps its existing metadata stamps (expiry/eligibility/completeness)',
  /cacheExpiresAt: new Date\(new Date\(result\.fetchedAt\)\.getTime\(\) \+ CACHE_TTL_MS\)/.test(backfill) &&
  /eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION/.test(backfill));

check('purchase boundary keeps the legacy selectedRateProof fallback (no new enforcement)',
  /falls back to the legacy carried selectedRateProof/i.test(store) ||
  /FALL BACK to the legacy carried proof/.test(store));
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
// PS-244: /rates/browse now routes through the SINGLE finalizer (finalizeBestRateWithQuote)
// instead of stamping the selection key + quote snapshot inline — browse and backfill can no
// longer diverge. selectedRateKey/rateQuoteId are byte-identical (shared pure fns); the best
// rate now also carries the backend-owned proofSource. The inline trio is GONE.
check('/rates/browse routes through the single finalizer (PS-244 — no inline re-stamping)',
  /const finalized = await finalizeBestRateWithQuote\(\{/.test(ratesRoute) &&
  /responseRates = finalized\.rates/.test(ratesRoute) &&
  !/const ratesWithKeys = withSelectedRateKeys\(combinedRates\)[\s\S]{0,80}storeRateQuoteSnapshot/.test(ratesRoute));

if (failures > 0) {
  console.error(`\nFAIL PS-174 quote-key consolidation guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-174 quote-key consolidation guard');
