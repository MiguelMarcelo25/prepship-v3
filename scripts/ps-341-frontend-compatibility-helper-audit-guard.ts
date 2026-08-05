import { readFileSync } from 'node:fs';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`PS-341 frontend compatibility helper audit failed: ${message}`);
  }
}

const proof = readFileSync('web/src/components/Views/orders/best-rate/rate-proof.ts', 'utf8');
const cells = readFileSync('web/src/components/Views/orders/cells/order-cells.tsx', 'utf8');

// PS-422 cleanup (2026-08-05): this used to require the file to CONTAIN
// `selectProofFromCandidates`, i.e. to still build a semantic proof payload. That builder had
// zero call sites and was deleted, so the assertion is now INVERTED: the frontend must not
// reintroduce a reconstructable proof payload here — the only selection route is the opaque
// backend-minted ref on the line below. This is strictly STRONGER than the pin it replaces
// (PS-313: the FE may never mint purchase authority).
// PS-422 retirement (2026-08-05, follow-up): the legacy selector itself has since been deleted
// from web/src/lib/rate-proof.ts too — it was the last symbol kept alive purely by guards. Its
// rules did not disappear: the account filter it shared is still executed against the live
// opaque selector (ps-198/ps-204/ps-302), the marker-gated fingerprint rule is pinned in the
// live consumer (ps-095/ps-103/recalculate-best-rate-strict), and ps-302 now pins that the
// semantic route cannot be reintroduced. The assertion below is unchanged and still forbids
// rebuilding a reconstructable proof payload in THIS file.
assert(!proof.includes('selectProofFromCandidates'), 'frontend proof helper must not rebuild a semantic, reconstructable proof payload');
assert(proof.includes('rateQuoteRefFromCandidates'), 'rate quote refs must delegate to shared selector');
assert(
  /export function buildRateQuoteRefForOrder\([\s\S]{0,400}?return rateQuoteRefFromCandidates\(/.test(proof),
  'the surviving payload builder must delegate to the shared opaque-ref selector',
);
assert(!proof.includes('createHash'), 'frontend proof helper must not hash/mint proof');
assert(!proof.includes('buildShippingRateRequestFingerprint'), 'frontend proof helper must not build backend rate fingerprints');

assert(proof.includes('getSavedBestRateRecord'), 'saved best-rate reader must remain visible and tiny');
assert(
  /export function getSavedBestRateRecord\(order: OrderSummaryDto\) \{[\s\S]{0,260}return toRecord\(order\.bestRate\);[\s\S]{0,80}\}/.test(proof),
  'saved best-rate reader must consume only the normalized order.bestRate shape',
);
assert(!proof.includes('getShippingModel'), 'proof helper must not re-search shipping.bestRate');
assert(!proof.includes('bestRateJson'), 'proof helper must not re-search overrides.bestRateJson');

assert(cells.includes('getBackendRowMoney'), 'Best Rate cell must consume backend money tuple');
assert(
  cells.includes('FE-computed markup') && cells.includes('never'),
  'Best Rate cell must document no frontend markup fallback',
);
assert(!/customerRateAmount\s*=|markedAmount\s*=|marginAmount\s*=/.test(cells), 'cells must not assign authoritative rate money values');

console.log('PS-341 frontend compatibility helper audit guard passed');
