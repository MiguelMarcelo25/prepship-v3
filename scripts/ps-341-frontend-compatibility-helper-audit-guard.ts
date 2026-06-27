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

assert(proof.includes('getSavedBestRateRecord'), 'multi-shape saved best-rate reader must remain visible until removed');
assert(proof.includes('temporary compatibility bridge'), 'multi-shape saved best-rate reader must be marked as compatibility debt');
assert(
  proof.includes('order.bestRate') &&
    proof.includes('getShippingModel(order)?.bestRate') &&
    proof.includes('bestRateJson'),
  'multi-shape bridge must be tracked explicitly',
);

assert(cells.includes('getBackendRowMoney'), 'Best Rate cell must consume backend money tuple');
assert(
  cells.includes('FE-computed markup') && cells.includes('never'),
  'Best Rate cell must document no frontend markup fallback',
);
assert(!/customerRateAmount\s*=|markedAmount\s*=|marginAmount\s*=/.test(cells), 'cells must not assign authoritative rate money values');

console.log('PS-341 frontend compatibility helper audit guard passed');
