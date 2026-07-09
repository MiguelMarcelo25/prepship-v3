/** Historical PS-244 guard, updated after the PS-419 strict cutover. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getRateProofEnforcementStats,
  recordRateProofEnforcement,
  resetRateProofEnforcementStats,
} from '../src/services/shipping-workflow/rate-proof-enforcement';

resetRateProofEnforcementStats();
recordRateProofEnforcement('snapshot_enforced');
recordRateProofEnforcement('snapshot_rejected', 'snapshot_expired');
const stats = getRateProofEnforcementStats();
assert.equal(stats.mode, 'strict');
assert.equal(stats.outcomes.snapshot_enforced, 1);
assert.equal(stats.outcomes.snapshot_rejected, 1);
assert.equal(stats.reasons.snapshot_expired, 1);

const store = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
const enforcement = readFileSync('src/services/shipping-workflow/rate-proof-enforcement.ts', 'utf8');
const observability = readFileSync('src/routes/observability.ts', 'utf8');

assert.match(store, /assertRateQuoteSnapshotForLabelPurchase/);
assert.match(store, /Backend rate proof is required/);
assert.doesNotMatch(store, /snapshot_fallback|legacy_only|rateProofEnforcementMode/);
assert.doesNotMatch(store, /assertSelectedRateProofForLabelPurchase\(body\.selectedRateProof/);
assert.doesNotMatch(enforcement, /RATE_PROOF_ENFORCEMENT|canary/);
assert.match(observability, /rate-proof-enforcement/);
assert.match(observability, /getRateProofEnforcementStats/);

console.log('PASS PS-244 historical enforcement guard after PS-419 strict cutover');
