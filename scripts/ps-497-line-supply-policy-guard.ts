// PS-497 Slice 2 (S2.1) — the frozen supply/evidence disposition matrix, proven as a pure unit
// (no DB). Supply and line-evidence are orthogonal; only PrepShip + trustworthy lines deduct.
import assert from 'node:assert/strict';
import {
  decideClaimDisposition,
  resolveOccurrenceSupply,
  type LineEvidence,
} from '../src/services/fulfillment/line-supply-policy.js';

let passed = 0;
const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };

// resolveOccurrenceSupply
assert.equal(resolveOccurrenceSupply({ discriminatorKind: 'provider_shipment', external: false }), 'prepship');
assert.equal(resolveOccurrenceSupply({ discriminatorKind: 'local_shipment', external: false }), 'prepship');
assert.equal(resolveOccurrenceSupply({ discriminatorKind: 'whole_order', external: true }), 'external');
assert.equal(resolveOccurrenceSupply({ discriminatorKind: 'whole_order', external: false }), 'unknown');
ok('occurrence supply: shipment-backed -> prepship; whole_order+external -> external; whole_order -> unknown');

const good = { hasCanonicalSku: true, quantity: 2 as number | null, soleOutbound: false };

// prepship + exact shipment lines -> pending, EVEN for a split (soleOutbound false)
{
  const d = decideClaimDisposition({ supply: 'prepship', evidence: 'exact_shipment', ...good });
  assert.deepEqual(d, { supply: 'prepship', status: 'pending', enqueue: true });
}
ok('prepship + exact shipment lines -> pending+enqueue even for a split shipment (no sole-outbound demotion)');

// prepship + whole-order fallback -> pending ONLY when sole outbound
{
  const notSole = decideClaimDisposition({ supply: 'prepship', evidence: 'whole_order_fallback', ...good, soleOutbound: false });
  assert.deepEqual(notSole, { supply: 'prepship', status: 'review', enqueue: false });
  const sole = decideClaimDisposition({ supply: 'prepship', evidence: 'whole_order_fallback', ...good, soleOutbound: true });
  assert.deepEqual(sole, { supply: 'prepship', status: 'pending', enqueue: true });
}
ok('prepship + whole-order fallback -> pending ONLY when sole outbound, else review');

// prepship + unavailable/invalid -> review, supply stays prepship (never a pseudo-supply 'review')
for (const [label, input] of [
  ['unavailable', { supply: 'prepship' as const, evidence: 'unavailable' as LineEvidence, ...good }],
  ['missing sku', { supply: 'prepship' as const, evidence: 'exact_shipment' as LineEvidence, hasCanonicalSku: false, quantity: 2, soleOutbound: false }],
  ['null quantity', { supply: 'prepship' as const, evidence: 'exact_shipment' as LineEvidence, hasCanonicalSku: true, quantity: null, soleOutbound: false }],
  ['zero quantity', { supply: 'prepship' as const, evidence: 'exact_shipment' as LineEvidence, hasCanonicalSku: true, quantity: 0, soleOutbound: false }],
] as const) {
  const d = decideClaimDisposition(input);
  assert.deepEqual(d, { supply: 'prepship', status: 'review', enqueue: false }, `prepship ${label}`);
}
ok('prepship + unavailable/missing-sku/null-or-zero-qty -> review (supply stays prepship, no movement)');

// external -> not_applicable, unknown -> review, regardless of line evidence
for (const evidence of ['exact_shipment', 'whole_order_fallback', 'unavailable'] as LineEvidence[]) {
  assert.deepEqual(
    decideClaimDisposition({ supply: 'external', evidence, ...good, soleOutbound: true }),
    { supply: 'external', status: 'not_applicable', enqueue: false });
  assert.deepEqual(
    decideClaimDisposition({ supply: 'unknown', evidence, ...good, soleOutbound: true }),
    { supply: 'unknown', status: 'review', enqueue: false });
}
ok('external -> not_applicable (never deducts); unknown -> review (never deducts), for every line evidence');

console.log(`\nPASS PS-497 line-supply-policy — ${passed}/${passed} checks`);
