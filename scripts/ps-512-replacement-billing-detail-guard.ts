#!/usr/bin/env tsx
/**
 * PS-512 — replacement charges must not render $0.00 in the itemized billing detail.
 *
 * Proves, against the REAL canonical row builder (toBillingDetailOrderRows), that
 * replace_postage / replace_pick_pack money lands in the detail row's grandTotal AND its own
 * breakout columns, reconciles to the sum of components, and SURVIVES the outbound order's
 * cancellation (DJ ruling 2026-09-01, under `unlock shipped data`). Plus a COVERAGE guard:
 * every money-carrying writable line type must round-trip its amount to grandTotal, so a
 * future line type cannot silently drop to $0.00 the way replace_* did — the exact mechanism
 * that hid this bug (billingLineMetrics drops any unrecognized line type to 0).
 */
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';

let failures = 0;
function check(cond: boolean, msg: string, detail?: string): void {
  if (cond) console.log(`  PASS ${msg}`);
  else {
    console.error(`  FAIL ${msg}${detail ? `\n       ${detail}` : ''}`);
    failures += 1;
  }
}

type Row = Record<string, unknown>;
const line = (orderId: number, lineType: string, totalCost: number, extra: Row = {}): Row => ({
  orderId,
  orderNumber: String(orderId),
  lineType,
  totalCost: totalCost.toFixed(2),
  ...extra,
});
const rowsFor = (...rows: Row[]) => toBillingDetailOrderRows(rows);
const num = (v: unknown) => Number(v);

// 1 — replace_postage alone lands in grandTotal + its own column, no bleed.
{
  const [r] = rowsFor(line(1001, 'replace_postage', 8.75));
  check(num(r.grandTotal) === 8.75, 'replace_postage alone -> grandTotal 8.75 (was $0.00)', `got ${r.grandTotal}`);
  check(num(r.replacePostageTotal) === 8.75, 'replace_postage -> replacePostageTotal 8.75', `got ${r.replacePostageTotal}`);
  check(num(r.replacePickPackTotal) === 0, 'replace_postage -> replacePickPackTotal 0', `got ${r.replacePickPackTotal}`);
  check(num(r.shippingTotal) === 0, 'replace_postage does NOT bleed into shippingTotal', `got ${r.shippingTotal}`);
}

// 2 — replace_pick_pack alone.
{
  const [r] = rowsFor(line(1002, 'replace_pick_pack', 3.0));
  check(num(r.grandTotal) === 3.0, 'replace_pick_pack alone -> grandTotal 3.00 (was $0.00)', `got ${r.grandTotal}`);
  check(num(r.replacePickPackTotal) === 3.0, 'replace_pick_pack -> replacePickPackTotal 3.00', `got ${r.replacePickPackTotal}`);
  check(num(r.pickpackTotal) === 0, 'replace_pick_pack does NOT bleed into pickpackTotal', `got ${r.pickpackTotal}`);
}

// 3 & 4 — a mixed outbound order reconciles: components sum to grandTotal.
{
  const [r] = rowsFor(
    line(1003, 'pick_pack', 4.0),
    line(1003, 'shipping', 5.0),
    line(1003, 'replace_postage', 8.75),
    line(1003, 'replace_pick_pack', 3.0),
  );
  check(num(r.grandTotal) === 20.75, 'mixed order -> grandTotal 20.75', `got ${r.grandTotal}`);
  const componentSum =
    num(r.pickpackTotal) + num(r.additionalTotal) + num(r.packageTotal) + num(r.shippingTotal) +
    num(r.storageTotal) + num(r.adjustmentTotal) + num(r.returnTotal) +
    num(r.replacePostageTotal) + num(r.replacePickPackTotal);
  check(Math.abs(componentSum - num(r.grandTotal)) < 0.005,
    'RECONCILIATION: component columns (incl. replace) sum to grandTotal',
    `components ${componentSum} vs grandTotal ${r.grandTotal}`);
}

// 5 — COVERAGE: every money-carrying line type round-trips its amount to grandTotal.
{
  const MONEY_TYPES = [
    'pick_pack', 'additional_unit', 'shipping', 'package_cost', 'storage',
    'billing_adjustment', 'return_postage', 'return_processing_fee',
    'replace_postage', 'replace_pick_pack',
  ];
  for (const t of MONEY_TYPES) {
    const [r] = rowsFor(line(2000, t, 7.0));
    check(Math.abs(num(r.grandTotal) - 7.0) < 0.005,
      `coverage: '${t}' money reaches grandTotal (not silently dropped to $0.00)`, `got ${r.grandTotal}`);
  }
}

// 6 & 7 — cancelled original: replacement SURVIVES, prep is zeroed, and it reconciles.
{
  const [r] = rowsFor(
    line(3001, 'pick_pack', 4.0, { orderStatus: 'cancelled' }),
    line(3001, 'replace_postage', 8.75, { orderStatus: 'cancelled' }),
    line(3001, 'replace_pick_pack', 3.0, { orderStatus: 'cancelled' }),
  );
  check(num(r.pickpackTotal) === 0, 'cancelled: prep pick_pack is zeroed (no-charge)', `got ${r.pickpackTotal}`);
  check(num(r.replacePostageTotal) === 8.75, 'cancelled: replacePostageTotal SURVIVES (8.75)', `got ${r.replacePostageTotal}`);
  check(num(r.replacePickPackTotal) === 3.0, 'cancelled: replacePickPackTotal SURVIVES (3.00)', `got ${r.replacePickPackTotal}`);
  check(num(r.grandTotal) === 11.75, 'cancelled: grandTotal == surviving replacement money (11.75), not 0', `got ${r.grandTotal}`);
  const componentSum = num(r.pickpackTotal) + num(r.replacePostageTotal) + num(r.replacePickPackTotal);
  check(Math.abs(componentSum - num(r.grandTotal)) < 0.005,
    'cancelled RECONCILIATION: surviving components == grandTotal', `${componentSum} vs ${r.grandTotal}`);
}

// 8 — the isReturnLine gate holds: a return line never carries replacement money.
{
  const [r] = rowsFor(line(4001, 'return_postage', 6.0, { returnId: 77 }));
  check(num(r.replacePostageTotal ?? 0) === 0, 'return line -> replacePostageTotal 0 (no cross-family leak)', `got ${r.replacePostageTotal}`);
}

// 9 — documents the audit correction: the real spelling is billing_adjustment, not adjustment.
{
  const [good] = rowsFor(line(5001, 'billing_adjustment', -12.5));
  check(num(good.adjustmentTotal) === -12.5, "'billing_adjustment' -> adjustmentTotal -12.50 (real persisted spelling)", `got ${good.adjustmentTotal}`);
  const [bad] = rowsFor(line(5002, 'adjustment', -12.5));
  check(num(bad.grandTotal) === 0, "'adjustment' (wrong spelling) -> 0 (documents the CP-059 fixture bug, not a PS-512 defect)", `got ${bad.grandTotal}`);
}

console.log(`\n${failures === 0 ? 'PASS PS-512 replacement billing-detail guard' : `FAIL PS-512 — ${failures} check(s) failed`}`);
if (failures > 0) process.exit(1);
