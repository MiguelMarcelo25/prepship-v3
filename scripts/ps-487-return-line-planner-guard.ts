/**
 * PS-487 slice 2 guard — the return billing LINE PLANNER.
 *
 * Offline/pure: no DB, no network, no provider calls, no billing regeneration, no
 * production mutation. Drives the real planner over the shapes production actually
 * holds.
 */
import assert from 'node:assert/strict';
import {
  planReturnBillingLines,
  returnLineDescription,
  type ReturnBillingSourceRow,
} from '../src/services/billing-return-line-planner';
import { returnBillingEventKey } from '../src/services/billing-return-event-contract';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const FEE = new Map<number, number>([[4, 3.5]]);
const row = (o: Partial<ReturnBillingSourceRow> = {}): ReturnBillingSourceRow => ({
  id: 100,
  orderId: 900,
  orderNumber: 'PS-900',
  clientId: 4,
  createdAt: '2026-08-10T12:00:00.000Z',
  returnCustomerShippingRate: '6.77',
  returnReference: '900-RETURN',
  ...o,
});

// ── AC-1: billed at creation, no label required ──────────────────────────────
check('a return with no shipment/label still produces its processing line', () => {
  const { lines } = planReturnBillingLines({
    returns: [row({ returnCustomerShippingRate: null })],
    returnProcessingFeeByClientId: FEE,
  });
  const processing = lines.filter((l) => l.lineType === 'return_processing');
  assert.equal(processing.length, 1);
  assert.equal(processing[0]!.totalCost, '3.50');
  assert.equal(lines.filter((l) => l.lineType === 'return_label').length, 0);
});

check('exactly ONE processing line per return (never two)', () => {
  const { lines } = planReturnBillingLines({
    returns: [row(), row({ id: 101, orderId: 901 })],
    returnProcessingFeeByClientId: FEE,
  });
  assert.equal(lines.filter((l) => l.lineType === 'return_processing').length, 2);
  const keys = lines.map((l) => l.eventKey);
  assert.equal(new Set(keys).size, keys.length, 'every planned line must be uniquely keyed');
});

// ── AC-2: customer rate, never internal cost ─────────────────────────────────
check('return shipping bills the configured CUSTOMER rate', () => {
  const { lines } = planReturnBillingLines({
    returns: [row({ returnCustomerShippingRate: '8.64' })],
    returnProcessingFeeByClientId: FEE,
  });
  const shipping = lines.find((l) => l.lineType === 'return_label')!;
  assert.equal(shipping.totalCost, '8.64');
});

check('a configured $0.00 return still produces a VISIBLE $0 line', () => {
  // Three production returns carry exactly 0.00. Emitting nothing would hide a real
  // return from the invoice; this codebase already shows $0 rows (PS-377 cancelled).
  const { lines, skipped } = planReturnBillingLines({
    returns: [row({ returnCustomerShippingRate: '0.00' })],
    returnProcessingFeeByClientId: FEE,
  });
  const shipping = lines.find((l) => l.lineType === 'return_label');
  assert.ok(shipping, 'a $0.00 configured rate must still emit a line');
  assert.equal(shipping!.totalCost, '0.00');
  assert.equal(skipped.length, 0);
});

check('NO configured customer rate bills no shipping line, and says why', () => {
  const { lines, skipped } = planReturnBillingLines({
    returns: [row({ returnCustomerShippingRate: null })],
    returnProcessingFeeByClientId: FEE,
  });
  assert.equal(lines.filter((l) => l.lineType === 'return_label').length, 0);
  assert.deepEqual(skipped, [{ returnId: 100, reason: 'no_customer_shipping_rate' }]);
});

// ── forward-only cutover ─────────────────────────────────────────────────────
check('the 8 historic production returns plan NOTHING', () => {
  const historic: Array<[number, number, string, string]> = [
    [1, 1371187, '2026-07-06', '0.00'], [2, 1445323, '2026-07-08', '0.00'],
    [3, 1443950, '2026-07-09', '0.00'], [4, 1497283, '2026-07-16', '6.77'],
    [6, 1446076, '2026-07-16', '6.77'], [7, 1452409, '2026-07-17', '6.77'],
    [8, 1201393, '2026-07-20', '7.95'], [9, 1381060, '2026-07-20', '8.64'],
  ];
  const { lines, skipped } = planReturnBillingLines({
    returns: historic.map(([id, orderId, createdAt, rate]) =>
      row({ id, orderId, createdAt, returnCustomerShippingRate: rate })),
    returnProcessingFeeByClientId: FEE,
  });
  assert.equal(lines.length, 0, 'no historic return may be billed');
  assert.equal(skipped.length, 8);
  assert.ok(skipped.every((s) => s.reason === 'before_cutover'));
});

check('the skip reason distinguishes POLICY from missing data', () => {
  const { skipped } = planReturnBillingLines({
    returns: [
      row({ id: 1, createdAt: '2026-07-06' }),   // policy
      row({ id: 2, createdAt: null }),           // data
      row({ id: 3, clientId: null }),            // data
    ],
    returnProcessingFeeByClientId: FEE,
  });
  assert.equal(skipped.find((s) => s.returnId === 1)!.reason, 'before_cutover');
  assert.equal(skipped.find((s) => s.returnId === 2)!.reason, 'not_eligible');
  assert.equal(skipped.find((s) => s.returnId === 3)!.reason, 'no_client');
});

// ── AC-3 / AC-5: dates and idempotency identity ──────────────────────────────
check('the invoice bucket follows an admin correction; activity day does not', () => {
  const { lines } = planReturnBillingLines({
    returns: [row({ createdAt: '2026-08-10', billingDateOverride: '2026-09-02' })],
    returnProcessingFeeByClientId: FEE,
  });
  const l = lines[0]!;
  assert.equal(l.shipDate, '2026-08-10', 'actual activity day is preserved');
  assert.equal(l.billingEffectiveDate, '2026-09-02', 'invoice bucket follows the correction');
});

check('a date correction does NOT change the description (so it MOVES, not duplicates)', () => {
  const before = planReturnBillingLines({
    returns: [row()], returnProcessingFeeByClientId: FEE,
  }).lines.map((l) => l.description).sort();
  const after = planReturnBillingLines({
    returns: [row({ billingDateOverride: '2026-09-02' })], returnProcessingFeeByClientId: FEE,
  }).lines.map((l) => l.description).sort();
  assert.deepEqual(after, before,
    'the DB dedupes on description — if a correction changed it, the client would be billed twice');
});

check('the description carries the canonical event key the DB dedupes on', () => {
  const d = returnLineDescription({ kind: 'return_processing', returnId: 42, returnReference: '42-RETURN' });
  assert.ok(d.includes(returnBillingEventKey({ returnId: 42, kind: 'return_processing' })));
  assert.ok(d.startsWith('Return processing'), 'invoices stay human-readable');
});

check('processing and shipping descriptions differ (they are separate unique rows)', () => {
  assert.notEqual(
    returnLineDescription({ kind: 'return_processing', returnId: 7 }),
    returnLineDescription({ kind: 'return_label', returnId: 7 }),
  );
});

check('an unconfigured client fee plans $0.00 rather than crashing or skipping', () => {
  // Every client currently has return_processing_fee = 0.00, so this is the live shape.
  const { lines } = planReturnBillingLines({
    returns: [row({ clientId: 9 })],
    returnProcessingFeeByClientId: new Map(),
  });
  assert.equal(lines.find((l) => l.lineType === 'return_processing')!.totalCost, '0.00');
});

if (failures > 0) {
  console.error(`\nFAIL PS-487 return line planner guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-487 return line planner guard');
