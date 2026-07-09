import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertLabelPurchaseRateSelection,
  assertRateQuoteSnapshotForLabelPurchase,
} from '../src/services/shipping-workflow/rate-quote-snapshot-store';
import {
  RATE_QUOTE_SNAPSHOT_TTL_MS,
  resolveRateQuoteForPurchase,
  selectedRateOpaqueKey,
  type RateQuoteSnapshot,
} from '../src/services/shipping-workflow/rate-quote-snapshot';
import {
  SelectedRateProofError,
  classifyLabelPurchaseRetry,
} from '../src/services/shipping-workflow/rate-fingerprint';
import {
  getRateProofEnforcementStats,
  recordRateProofEnforcement,
  resetRateProofEnforcementStats,
} from '../src/services/shipping-workflow/rate-proof-enforcement';

const cacheKey =
  'v=ground-saver-v2|d=2026-07-10|w=48|z=90019|co=US|r=1|cl=120|l=90|dw=60|h=30|c=se-1001,se-1002';
const rate = {
  carrierCode: 'ups',
  serviceCode: 'ups_ground',
  shippingProviderId: 1001,
  shipmentCost: 8.42,
  otherCost: 0,
  packageCode: 'package',
};
const selectedRateKey = selectedRateOpaqueKey(rate);
const snapshot: RateQuoteSnapshot = {
  cacheKey,
  rates: [rate],
  fetchedAt: Date.now(),
  bestRateKey: selectedRateKey,
  bestRateComplete: true,
};

function thrownProofError(run: () => unknown): SelectedRateProofError | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof SelectedRateProofError ? error : null;
  }
}

const resolved = resolveRateQuoteForPurchase({ snapshot, selectedRateKey });
assert.equal(resolved.ok, true, 'fixture must resolve through the backend snapshot owner');

const proof = assertRateQuoteSnapshotForLabelPurchase({
  snapshot,
  selectedRateKey,
  purchaseShippingProviderId: 1001,
});
assert.equal(proof.requestFingerprint, cacheKey, 'strict resolver returns backend snapshot proof');

const missing = thrownProofError(() => assertRateQuoteSnapshotForLabelPurchase({
  snapshot: null,
  selectedRateKey,
  purchaseShippingProviderId: 1001,
}));
assert.equal(missing?.details.reason, 'snapshot_missing', 'missing backend snapshot must fail closed');
assert.equal(classifyLabelPurchaseRetry(missing).retryEligible, true, 'missing snapshot must prompt re-rate');

const expired = thrownProofError(() => assertRateQuoteSnapshotForLabelPurchase({
  snapshot: {
    ...snapshot,
    fetchedAt: Date.now() - RATE_QUOTE_SNAPSHOT_TTL_MS - 1,
  },
  selectedRateKey,
  purchaseShippingProviderId: 1001,
}));
assert.equal(expired?.details.reason, 'snapshot_expired', 'expired backend snapshot must fail closed');

const wrongKey = thrownProofError(() => assertRateQuoteSnapshotForLabelPurchase({
  snapshot,
  selectedRateKey: 'sr_wrong',
  purchaseShippingProviderId: 1001,
}));
assert.equal(
  wrongKey?.details.reason,
  'selected_rate_not_in_snapshot',
  'unknown selection key must fail closed',
);

const missingRef = thrownProofError(() => assertRateQuoteSnapshotForLabelPurchase({
  snapshot,
  selectedRateKey: null,
  purchaseShippingProviderId: 1001,
}));
assert.equal(
  missingRef?.details.reason,
  'backend_rate_quote_required',
  'missing backend reference must produce an actionable structured reason',
);

assert.ok(resolved.ok);
await assert.rejects(
  () => assertLabelPurchaseRateSelection({ selectedRateProof: resolved.proof }),
  (error: unknown) =>
    error instanceof SelectedRateProofError &&
    error.details.reason === 'backend_rate_quote_required',
  'legacy carried proof alone must never authorize purchase',
);

resetRateProofEnforcementStats();
recordRateProofEnforcement('snapshot_enforced');
recordRateProofEnforcement('snapshot_rejected', 'snapshot_expired');
recordRateProofEnforcement('snapshot_reference_missing', 'backend_rate_quote_required');
const stats = getRateProofEnforcementStats();
assert.equal(stats.mode, 'strict');
assert.equal(stats.outcomes.snapshot_enforced, 1);
assert.equal(stats.outcomes.snapshot_rejected, 1);
assert.equal(stats.outcomes.snapshot_reference_missing, 1);

const store = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
const labels = readFileSync('src/services/labels.ts', 'utf8');
const preflight = readFileSync('src/services/print-queue/queue-send-preflight.ts', 'utf8');
const orders = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const bestRateProof = readFileSync('web/src/components/Views/orders/best-rate/rate-proof.ts', 'utf8');

assert.doesNotMatch(store, /assertSelectedRateProofForLabelPurchase\(body\.selectedRateProof/);
assert.doesNotMatch(store, /snapshot_fallback|legacy_only|rateProofEnforcementMode/);
assert.match(store, /recordRateProofEnforcement\('snapshot_reference_missing'/);
assert.match(store, /recordRateProofEnforcement\('snapshot_rejected'/);
assert.match(store, /catch \{\s*return null;\s*\}/, 'failed snapshot writes must not return phantom ids');

assert.match(
  labels,
  /assertLabelPurchaseRateSelection\(\{[\s\S]{0,240}rateQuoteId: body\.rateQuoteId[\s\S]{0,120}selectedRateKey: body\.selectedRateKey/,
  'Create Label must pass backend snapshot references',
);
assert.match(
  preflight,
  /assertLabelPurchaseRateSelection\(\{[\s\S]{0,180}rateQuoteId: carrierLabel\.rateQuoteId[\s\S]{0,100}selectedRateKey: carrierLabel\.selectedRateKey/,
  'Print Queue preflight must pass backend snapshot references',
);
assert.match(orders, /\.\.\.buildRateQuoteRefForOrder\(order/);
assert.match(bestRateProof, /rateQuoteRefFromCandidates/);

console.log('PASS PS-419 strict rate snapshot no-legacy-fallback guard');
