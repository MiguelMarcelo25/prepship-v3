/**
 * PS-377 - cancelled orders are VISIBLE in Billing as $0 rows (was HUGRAB-only).
 *
 * Per user override unlock shipped data on 2026-07-04: cancelled orders are
 * billing source rows for EVERY client. PS-396 (2026-07-06) removes the old
 * billable-cancelled exception, so every cancelled/canceled fulfillment row is
 * no-charge. Read-model only - no orders/shipments source mutation.
 *
 * Offline (no db):
 *   Layer 1 - the inclusion policy (isBillingSourceOrderBillable).
 *   Layer 2 - the grouped billing-detail DTO the FE + Invoice consume: a cancelled
 *             $0 row is visible, badged CANCELLED, and adds no dollars.
 *   Layer 3 - source pins: the generator's $0 no-charge line for all cancelled rows,
 *             the DTO badge, and the FE rendering it verbatim.
 *
 *   npx tsx scripts/ps-377-cancelled-billing-rows-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isBillingSourceOrderBillable } from '../src/services/billing';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name} - ${err instanceof Error ? err.message : err}`);
  }
}
const read = (p: string) => readFileSync(p, 'utf8');

// Layer 1: inclusion policy - cancelled billable for EVERY client.
check('shipped order is billable (any client)', () => {
  assert.equal(isBillingSourceOrderBillable({ orderStatus: 'shipped', clientName: 'eBay - DJC' }), true);
});
check('PS-377: cancelled order is billable for a NON-HUGRAB client (was excluded)', () => {
  assert.equal(isBillingSourceOrderBillable({ orderStatus: 'cancelled', clientName: 'eBay - DJC' }), true);
});
check('upstream-cancelled awaiting order is billable through the lifecycle SOT', () => {
  assert.equal(
    isBillingSourceOrderBillable({
      orderStatus: 'awaiting_shipment',
      canonicalStatus: 'cancelled',
      clientName: 'eBay - DJC',
    }),
    true,
  );
});
check('cancelled order is billable for HUGRAB too', () => {
  assert.equal(isBillingSourceOrderBillable({ orderStatus: 'cancelled', clientName: 'HUGRAB' }), true);
});
check('a non-shipped / non-cancelled order is NOT billable', () => {
  assert.equal(isBillingSourceOrderBillable({ orderStatus: 'awaiting_shipment', clientName: 'x' }), false);
});

// Layer 2: the grouped DTO the FE + Invoice consume.
check('grouped DTO: a cancelled $0 order is visible, badged CANCELLED, adds no dollars', () => {
  const [dto] = toBillingDetailOrderRows([
    {
      orderId: 900, orderNumber: 'C900', lineType: 'cancelled', totalCost: '0.00',
      billingStatusBadge: 'CANCELLED', orderStatus: 'cancelled',
    },
  ]);
  assert.equal(dto.grandTotal, 0, 'cancelled row must add no dollars');
  assert.equal(dto.pickpackTotal, 0);
  assert.equal(dto.shippingTotal, 0);
  assert.equal(dto.packageTotal, 0);
  assert.equal(dto.billingStatusBadge, 'CANCELLED');
});
check('grouped DTO: a shipped order keeps its fees and is NOT badged cancelled', () => {
  const [dto] = toBillingDetailOrderRows([
    { orderId: 901, orderNumber: 'S901', lineType: 'pick_pack', totalCost: '2.50' },
  ]);
  assert.equal(dto.pickpackTotal, 2.5);
  assert.ok(dto.billingStatusBadge == null);
});

// Layer 3: source pins.
const billing = read('src/services/billing.ts');

check('policy: cancelled orders are billing source rows for every client (no HUGRAB-only branch)', () => {
  assert.ok(/resolveOrderLifecycleStatus\(\{[\s\S]*?canonicalStatus/.test(billing));
  assert.ok(/isBillingLifecycleSourceStatus\(lifecycle\)/.test(billing));
  assert.ok(/orderLifecycleBillingSourcePredicate\(\)/.test(billing));
  assert.ok(!/if \(status === 'cancelled'\) return normalizeBillingClientName\(input\.clientName\)/.test(billing));
});

check('generator: every cancelled/canceled fulfillment order is a SINGLE $0 "Cancelled" line', () => {
  assert.ok(/const cancelledNoCharge =[\s\S]*?isCancelledBillingStatus\(s\.orderStatus\)[\s\S]*?isCancelledBillingStatus\(s\.orderLifecycleStatus\)/.test(billing));
  assert.ok(/effectiveRows: LineRow\[\] = cancelledNoCharge[\s\S]*?lineType: 'cancelled'[\s\S]*?totalCost: '0\.00'[\s\S]*?applyPrepFeeWaiver\(rows, waived\)/.test(billing),
    'cancelled no-charge must swap to a single $0 cancelled line; else apply the normal rows');
  assert.ok(!/HUGRAB_CANCELLED_BILLING_CLIENT_NAME/.test(billing), 'PS-396 removed the HUGRAB billable-cancelled exception');
});

check('billingDetails emits the backend-owned CANCELLED status badge from lifecycle status', () => {
  assert.ok(/resolveBillingRowStatus\([\s\S]*?orderStatus: detailOrderStatus[\s\S]*?orderLifecycleStatus: rowLifecycle\.orderLifecycleStatus/.test(billing));
  assert.ok(/billingStatusBadge/.test(read('src/services/billing-row-status.ts')));
});

check('detail-row DTO carries billingStatusBadge to the collapsed order row', () => {
  assert.ok(/'billingStatusBadge'/.test(read('src/services/billing-detail-row-sot.ts')));
});

check('FE renders the CANCELLED badge from the backend field (no FE inference from $0)', () => {
  const table = read('web/src/components/Views/BillingDetailTable.tsx');
  assert.ok(/row\.billingStatusBadge === 'CANCELLED'/.test(table));
  assert.ok(/data-billing-badge="CANCELLED"/.test(table));
});

check('empty billing message no longer says HUGRAB-only cancelled', () => {
  assert.ok(/No billable shipped or cancelled orders found for this range\./.test(billing));
  assert.ok(!/HUGRAB cancelled orders found/.test(billing));
});

check('safety: the cancelled path writes generated billing_line_items only (no orders/shipments UPDATE/DELETE)', () => {
  assert.ok(!/\.update\(orders\)/.test(billing) && !/\.update\(shipments\)/.test(billing));
  assert.ok(!/delete\(orders\)/.test(billing) && !/delete\(shipments\)/.test(billing));
});

if (failures > 0) {
  console.error(`\nPS-377 cancelled billing rows guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-377 cancelled billing rows guard passed.');
