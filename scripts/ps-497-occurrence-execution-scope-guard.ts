// PS-497 Slice 2 Release B (S2.3) — the occurrence-execution scope owner, proven as a pure unit (no env/DB).
// Fail-closed: empty/malformed scope => zero eligibility; canary requires the frozen pre-projection floor;
// the structural fence (occurrence_id/canonical_line_identity/supply/status/not-superseded) is invariant.
import assert from 'node:assert/strict';
import type { FenceCandidate } from '../src/services/fulfillment/occurrence-execution-scope.js';

// The module imports the env-validated db-adjacent lib; set offline env BEFORE importing. Pure test — no DB.
process.env.VERCEL ??= '1';
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ??= 'http://localhost';

const { buildOccurrenceExecutionScope, claimEligibleForExecution, assertExecutionScopeReady } = await import(
  '../src/services/fulfillment/occurrence-execution-scope.js'
);

let passed = 0;
const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };

const good: FenceCandidate = {
  occurrenceId: 100, canonicalLineIdentity: 'sku:0', supply: 'prepship', status: 'pending',
  superseded: false, clientId: 7, storeId: 3, orderId: 42,
};
const canaryScope = buildOccurrenceExecutionScope({ mode: 'canary', clientIds: '7', storeIds: undefined, orderIds: undefined, preProjectionMaxId: 50 });

// A configured canary scope is valid; an eligible claim passes.
assert.equal(canaryScope.valid, true, canaryScope.reason);
assert.equal(claimEligibleForExecution(good, canaryScope).eligible, true);
ok('valid canary scope + a prepship/pending/above-floor/in-client claim is eligible');

// Empty / malformed / missing-floor => zero eligibility (fail-closed).
{
  const empty = buildOccurrenceExecutionScope({ mode: 'canary', clientIds: undefined, storeIds: undefined, orderIds: undefined, preProjectionMaxId: 50 });
  assert.equal(empty.valid, false, 'no id configured => invalid');
  assert.equal(claimEligibleForExecution(good, empty).eligible, false);
  assert.throws(() => assertExecutionScopeReady(empty), /refusing to execute/);

  const malformed = buildOccurrenceExecutionScope({ mode: 'canary', clientIds: '7, abc', storeIds: undefined, orderIds: undefined, preProjectionMaxId: 50 });
  assert.equal(malformed.valid, false, 'malformed token => invalid');

  const noFloor = buildOccurrenceExecutionScope({ mode: 'canary', clientIds: '7', storeIds: undefined, orderIds: undefined, preProjectionMaxId: null });
  assert.equal(noFloor.valid, false, 'canary with no floor => invalid');
  assert.equal(claimEligibleForExecution(good, noFloor).eligible, false);
}
ok('empty / malformed / missing-canary-floor scope => invalid + zero eligibility (fail-closed, throws on assert)');

// The canary floor: occurrence_id must be STRICTLY above the frozen max.
{
  assert.equal(claimEligibleForExecution({ ...good, occurrenceId: 50 }, canaryScope).eligible, false, 'at the floor is not above it');
  assert.equal(claimEligibleForExecution({ ...good, occurrenceId: 51 }, canaryScope).eligible, true);
  const broad = buildOccurrenceExecutionScope({ mode: 'broad', clientIds: '7', storeIds: undefined, orderIds: undefined, preProjectionMaxId: null });
  assert.equal(broad.valid, true, 'broad needs no floor');
  assert.equal(claimEligibleForExecution({ ...good, occurrenceId: 1 }, broad).eligible, true, 'broad lifts the floor');
}
ok('canary requires occurrence_id strictly above the frozen floor; broad lifts the floor but keeps the fence');

// The structural fence is invariant regardless of scope.
for (const [label, mut] of [
  ['null occurrence', { occurrenceId: null }],
  ['null canonical identity', { canonicalLineIdentity: null }],
  ['external supply', { supply: 'external' }],
  ['unknown supply', { supply: 'unknown' }],
  ['status review', { status: 'review' }],
  ['status not_applicable', { status: 'not_applicable' }],
  ['superseded', { superseded: true }],
] as const) {
  assert.equal(claimEligibleForExecution({ ...good, ...mut }, canaryScope).eligible, false, `fenced: ${label}`);
}
ok('structural fence invariant: null occ/identity, external/unknown supply, non-pending status, superseded all fenced');

// Allowlist: each CONFIGURED dimension is a required match; unconfigured dimensions are not filters.
{
  const byClientOnly = canaryScope; // only client 7 configured
  assert.equal(claimEligibleForExecution({ ...good, clientId: 8 }, byClientOnly).eligible, false, 'wrong client fenced');
  assert.equal(claimEligibleForExecution({ ...good, storeId: 999, orderId: 999 }, byClientOnly).eligible, true, 'store/order unconstrained when unconfigured');
  const multi = buildOccurrenceExecutionScope({ mode: 'broad', clientIds: '7', storeIds: '3', orderIds: '42', preProjectionMaxId: null });
  assert.equal(claimEligibleForExecution(good, multi).eligible, true);
  assert.equal(claimEligibleForExecution({ ...good, storeId: 4 }, multi).eligible, false, 'wrong store fenced when store configured');
}
ok('allowlist: configured dimensions are required matches; unconfigured dimensions impose no filter');

console.log(`\nPASS PS-497 occurrence-execution-scope — ${passed}/${passed} checks`);
