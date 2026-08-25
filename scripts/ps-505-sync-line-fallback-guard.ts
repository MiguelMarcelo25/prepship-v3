#!/usr/bin/env tsx
/**
 * PS-505 — a ShipStation shipment with no line quantities must still deduct, when it is
 * provably the whole order.
 *
 * Measured against production on 2026-08-12:
 *   before PS-497 (<= 08-07): 1231 of our shipped orders, 1181 never deducted (95.9%)
 *   after  PS-497 (08-08+)  :  165 of our shipped orders,   15 never deducted ( 9.1%)
 * All 15 residual orders had exactly ONE outbound shipment — the case PS-497's
 * `loadWholeOrderShipmentLines` already answers safely. They stranded only because
 * `shipment-sync` went straight to `kind: 'unavailable'` whenever ShipStation omitted
 * `shipmentItems`.
 *
 * `shipment_sync` is a FIXED path in `inventory-claim-review-alarm.ts`, meaning ANY review
 * inflow is a regression with a zero threshold. That is the alarm that has been firing:
 * `inventory_claim.fixed_regression.shipment_sync`.
 *
 * THE SAFETY PROPERTY: the fallback must be gated on the shipment being the order's sole
 * live outbound shipment. Reading the order's lines is valid shipment truth only when the
 * shipment's scope equals the order's scope. On a split order the same lines would be
 * claimed by every shipment and stock would be deducted twice. Every mutation test below
 * exists to keep that gate in place.
 *
 * Hermetic: reads files, imports nothing that touches a database.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let checks = 0;
const check = (label: string, fn: () => void) => {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
};

console.log('PS-505 sync line-fallback guard');

const syncSource = readFileSync('src/services/shipment-sync.ts', 'utf8');
const soleSource = readFileSync('src/services/fulfillment/sole-outbound-shipment.ts', 'utf8');
const linesSource = readFileSync('src/services/shipment-fulfillment-lines.ts', 'utf8');

// Narrow to the block that builds fulfillmentFacts for an outbound shipment.
const factsStart = syncSource.indexOf('const providerLines');
assert.notEqual(factsStart, -1, 'shipment-sync must build providerLines');
const factsBlock = syncSource.slice(factsStart, factsStart + 1400);

check('provider-supplied lines are still preferred', () => {
  // PS-497 Release B: shipment-sync tags the provider-line branch with evidence='exact_shipment' (shipment-
  // scoped lines deduct even for a split) and the fallback branch with whole_order_fallback + soleOutbound;
  // the provider payload still wins when it has lines.
  assert.match(
    factsBlock,
    /providerLines\s*\?\s*\{\s*kind:\s*'exact'\s*as const,\s*evidence:\s*'exact_shipment'\s*as const,\s*lines:\s*providerLines\s*\}/,
    'the provider payload must win when it has lines'
  );
});

check('the fallback only runs when the provider gave nothing', () => {
  assert.match(
    factsBlock,
    /const wholeOrderLines\s*=\s*providerLines\s*\r?\n?\s*\?\s*null/,
    'wholeOrderLines must be null whenever providerLines exist'
  );
});

// The load-bearing one.
check('the fallback is GATED on sole-outbound-shipment', () => {
  assert.match(
    factsBlock,
    /isSoleOutboundShipment\(tx, row\.orderId, row\.id\)[\s\S]{0,120}loadWholeOrderShipmentLines\(row\.orderId, tx\)/,
    'loadWholeOrderShipmentLines must be reachable ONLY behind isSoleOutboundShipment — ' +
      'without that gate a split order deducts the same lines once per shipment'
  );
});

check('an ungated call to loadWholeOrderShipmentLines does not exist in sync', () => {
  const calls = [...syncSource.matchAll(/loadWholeOrderShipmentLines\(/g)];
  assert.equal(calls.length, 1, 'exactly one call site, the gated one');
});

check('a shipment with neither source still falls back to unavailable', () => {
  assert.match(
    factsBlock,
    /kind:\s*'unavailable'\s*as const/,
    'uncertainty must still produce a review receipt, never a fabricated deduction'
  );
});

check('PS-497 remains the line source — no hand-rolled query', () => {
  assert(
    !factsBlock.includes('select(') && !factsBlock.includes('orderItems'),
    'sync must not re-derive order lines itself; it must call the canonical resolver'
  );
});

// ── The gate's own semantics ────────────────────────────────────────────────
check('the gate excludes voided shipments and returns', () => {
  assert.match(soleSource, /voided/, 'voided shipments consume no outbound stock');
  assert.match(soleSource, /isReturn/, 'returns consume no outbound stock');
});

check('the gate requires the caller shipment to itself be live', () => {
  assert.match(
    soleSource,
    /if \(!self\) return false/,
    'a voided or return shipment must not qualify for a whole-order deduction'
  );
});

check('the gate fails closed on any other live outbound shipment', () => {
  assert.match(
    soleSource,
    /count\(\*\)::int[\s\S]{0,400}=== 0/,
    'more than one live outbound shipment must return false'
  );
});

// ── The resolver PS-497 already hardened ────────────────────────────────────
check('the resolver still refuses partial line lists', () => {
  assert.match(
    linesSource,
    /if \(!Number\.isFinite\(quantity\) \|\| !Number\.isInteger\(quantity\) \|\| quantity <= 0\) return null/,
    'one unusable line must invalidate the whole list, not deduct the rest'
  );
});

check('the resolver still returns null for an order with no lines', () => {
  assert.match(linesSource, /if \(rows\.length === 0\) return null/);
});

console.log(`\nPS-505 guard passed — ${checks} checks.`);
