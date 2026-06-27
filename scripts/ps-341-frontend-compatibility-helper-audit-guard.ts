import { readFileSync } from 'node:fs';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`PS-341 frontend compatibility helper audit failed: ${message}`);
  }
}

const proof = readFileSync('web/src/components/Views/orders/best-rate/rate-proof.ts', 'utf8');
const cells = readFileSync('web/src/components/Views/orders/cells/order-cells.tsx', 'utf8');

assert(proof.includes('selectProofFromCandidates'), 'proof payload must delegate to shared backend-issued proof selector');
assert(proof.includes('rateQuoteRefFromCandidates'), 'rate quote refs must delegate to shared selector');
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
