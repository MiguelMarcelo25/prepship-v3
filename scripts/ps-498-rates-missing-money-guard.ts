#!/usr/bin/env tsx
/**
 * PS-498 — the Rates screen must show missing money honestly.
 *
 * `buildRateRows` used to make three false financial claims:
 *
 *   const baseCost  = finiteNumber(rate.selectedRateCost)      ?? 0
 *   const yourPrice = finiteNumber(rate.cShippingRateAmount)   ?? baseCost
 *   const profit    = finiteNumber(rate.shippingMarginAmount)  ?? 0
 *
 * An unknown internal cost became $0.00. An unknown CUSTOMER price became the
 * internal label cost — displayed under a customer-facing label, and used as the
 * sort key. An unknown margin became $0.00 profit. Operators could not tell a
 * real price from a borrowed one.
 *
 * This exercises the REAL exported `buildRateRows` and `formatRateMoney`, not a
 * re-implementation: a test asserting against its own copy of the formula only
 * proves the copy is self-consistent.
 *
 * Hermetic — `rates-parity.ts` has no imports, touches no DB, network or carrier.
 */
import assert from 'node:assert/strict';
import {
  buildRateRows,
  buildRateSelectionToast,
  formatRateMoney,
} from '../web/src/components/Views/rates-parity';

let checks = 0;
const check = (label: string, fn: () => void) => {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
};

/** A backend rate DTO. Omitted keys model a field the backend did not supply. */
const rate = (fields: Record<string, unknown>) => ({
  carrierCode: 'ups',
  serviceName: 'Ground',
  selectedRateKey: 'ups:ground:1',
  rateSourceLabel: 'shipstation',
  ...fields,
});

const rowFor = (fields: Record<string, unknown>) => buildRateRows([rate(fields)])[0]!;

console.log('PS-498 rates missing-money guard');

// ── The matrix ──────────────────────────────────────────────────────────────
check('complete tuple survives verbatim', () => {
  const row = rowFor({ cShippingRateAmount: 8.25, selectedRateCost: 6.0, shippingMarginAmount: 2.25 });
  assert.equal(row.customerShippingRate, 8.25);
  assert.equal(row.selectedRateCost, 6.0);
  assert.equal(row.shippingMarginAmount, 2.25);
});

check('missing customer rate NEVER borrows the selected cost', () => {
  // The headline defect: $6.00 internal cost shown as the customer's price.
  const row = rowFor({ selectedRateCost: 6.0 });
  assert.equal(row.customerShippingRate, null, 'must stay unknown, not become 6.00');
  assert.equal(row.shippingMarginAmount, null);
  assert.equal(row.selectedRateCost, 6.0);
  assert.equal(formatRateMoney(row.customerShippingRate), 'Unavailable');
  assert.notEqual(formatRateMoney(row.customerShippingRate), '$6.00');
});

check('explicit zero is real money, not missing', () => {
  const row = rowFor({ cShippingRateAmount: 0, selectedRateCost: 0, shippingMarginAmount: 0 });
  assert.equal(row.customerShippingRate, 0);
  assert.equal(row.selectedRateCost, 0);
  assert.equal(row.shippingMarginAmount, 0);
  for (const value of [row.customerShippingRate, row.selectedRateCost, row.shippingMarginAmount]) {
    assert.equal(formatRateMoney(value), '$0.00', 'an owned zero must render as money');
  }
});

check('missing margin does not become zero profit', () => {
  const row = rowFor({ cShippingRateAmount: 8.25, selectedRateCost: 6.0 });
  assert.equal(row.customerShippingRate, 8.25);
  assert.equal(row.selectedRateCost, 6.0);
  assert.equal(row.shippingMarginAmount, null, 'unknown margin must not read as $0.00 profit');
  assert.equal(formatRateMoney(row.shippingMarginAmount), 'Unavailable');
});

check('contradictory tuple fails closed on the customer rate', () => {
  // Margin present but customer rate absent. The margin must NOT be used to
  // reconstruct a customer price, and the cost must not stand in for one.
  const row = rowFor({ selectedRateCost: 6.0, shippingMarginAmount: 2.25 });
  assert.equal(row.customerShippingRate, null);
  assert.notEqual(row.customerShippingRate, 8.25, 'must not be rebuilt from cost + margin');
  assert.equal(formatRateMoney(row.customerShippingRate), 'Unavailable');
});

check('a known customer rate survives an unknown cost and margin', () => {
  const row = rowFor({ cShippingRateAmount: 8.25 });
  assert.equal(row.customerShippingRate, 8.25);
  assert.equal(row.selectedRateCost, null);
  assert.equal(row.shippingMarginAmount, null);
});

check('non-numeric backend values are missing, not zero', () => {
  const row = rowFor({ cShippingRateAmount: 'n/a', selectedRateCost: null, shippingMarginAmount: undefined });
  assert.equal(row.customerShippingRate, null);
  assert.equal(row.selectedRateCost, null);
  assert.equal(row.shippingMarginAmount, null);
});

// ── Backend authority is untouched ──────────────────────────────────────────
check('best-rate identity still comes from the backend selectedRateKey', () => {
  const cheap = rate({ selectedRateKey: 'usps:ground:9', cShippingRateAmount: 4.0 });
  const best = rate({ selectedRateKey: 'ups:ground:1', cShippingRateAmount: 8.25 });
  const rows = buildRateRows([cheap, best], best);
  assert.equal(rows.find((r) => r.rate === best)!.isBest, true);
  assert.equal(rows.find((r) => r.rate === cheap)!.isBest, false,
    'the numerically cheaper row must NOT win the badge — identity is backend-owned');
});

check('a missing customer rate cannot win the best-rate badge by default', () => {
  const rows = buildRateRows([rate({ selectedRateCost: 6.0 })], null);
  assert.equal(rows[0]!.isBest, false);
});

check('each row keeps the original rate object for selection', () => {
  const source = rate({ cShippingRateAmount: 8.25 });
  const row = buildRateRows([source])[0]!;
  assert.equal(row.rate, source, 'selection must act on the same object identity');
});

// ── Sorting ─────────────────────────────────────────────────────────────────
check('a missing customer rate does not sort as zero or as the cost', () => {
  // Mirrors the column: sortValue = customerShippingRate ?? +Infinity.
  const sortValue = (r: { customerShippingRate: number | null }) =>
    r.customerShippingRate ?? Number.POSITIVE_INFINITY;
  const rows = buildRateRows([
    rate({ selectedRateKey: 'a', cShippingRateAmount: 8.25, selectedRateCost: 6.0 }),
    rate({ selectedRateKey: 'b', selectedRateCost: 1.0 }),
    rate({ selectedRateKey: 'c', cShippingRateAmount: 4.0 }),
  ]);
  const order = [...rows].sort((x, y) => sortValue(x) - sortValue(y))
    .map((r) => String((r.rate as { selectedRateKey: string }).selectedRateKey));
  assert.deepEqual(order, ['c', 'a', 'b'],
    'the unknown row must not sort among the cheapest as $0.00 or as its $1.00 cost');
});

// ── Selection toast ─────────────────────────────────────────────────────────
check('the toast quotes a known customer rate', () => {
  const row = rowFor({ cShippingRateAmount: 8.25 });
  assert.match(buildRateSelectionToast(row), /\$8\.25/);
});

check('the toast neither crashes nor quotes another amount when the rate is missing', () => {
  // Previously `row.yourPrice.toFixed(2)` — a TypeError once the value could be null.
  const row = rowFor({ selectedRateCost: 6.0 });
  const toast = buildRateSelectionToast(row);
  assert.match(toast, /Customer Shipping Rate unavailable/);
  assert(!toast.includes('$6.00'), 'must not quote the internal cost as the customer rate');
});

check('an explicit $0.00 customer rate is still quoted as money', () => {
  assert.match(buildRateSelectionToast(rowFor({ cShippingRateAmount: 0 })), /\$0\.00/);
});

console.log(`\nPS-498 guard passed — ${checks} checks.`);
