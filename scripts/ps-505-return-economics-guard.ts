#!/usr/bin/env tsx
/**
 * PS-505 — return billing economics are separated from outbound fulfillment rows,
 * and Billing Status is gone from the display/export surfaces.
 *
 * Hermetic: pure imports and file reads. No database, no network, no mutation.
 *
 * NAME COLLISION, deliberate and temporary. `scripts/ps-505-sync-line-fallback-guard.ts`
 * is NOT this card — it belongs to a shipment-sync inventory fix that was misnumbered
 * PS-505 in commit f206426a. THIS file is the real Trello card yY4wWkDA. The other one
 * keeps its wrong name until DJ assigns an official successor id, at which point it is
 * renamed atomically; renaming it now would swap one false identifier for a guessed one.
 *
 * THE FIXTURE IS THE POINT. PS-488 M3 already delivered return identity, grouping and
 * dedicated columns, so a test that only proves "returns form their own row" passes on
 * the code PS-505 was written to fix. What was still wrong is the MONEY:
 * `return_processing*` also fed pickPack and `return_postage`/`return_label`/`return`
 * also fed shipping while the dedicated buckets were populated too, so one return
 * charge sat in two semantic buckets and fulfillmentFeeTotal reported it as a
 * Fulfillment Fee. The #3074 row fixture below is what distinguishes the two states.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  toBillingDetailOrderRows,
  type BillingDetailReadModelRow,
} from '../src/services/billing-detail-row-sot.js';
import { resolveBillingInvoiceRowTotal } from '../src/services/billing-invoice-row-total.js';
import { INVOICE_CSV_HEADERS } from '../src/routes/billing-invoice-csv.js';
import {
  BILLING_DETAIL_COLUMNS,
  type BillingDetailColumn,
} from '../web/src/components/Views/billing-parity.js';

let passed = 0;
const failures: string[] = [];
const check = (label: string, fn: () => void): void => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    failures.push(`${label}\n        ${message}`);
    console.log(`  FAIL  ${label}\n        ${message}`);
  }
};

const money = (value: unknown): number => Math.round(Number(value) * 100) / 100;

// ── The #3074 fixture ────────────────────────────────────────────────────────
// One outbound order and one return against the same order, exactly as the card's
// screenshot shows them.
const OUTBOUND: BillingDetailReadModelRow[] = [
  { id: 4, orderId: 3074, orderNumber: '3074', lineType: 'pick_pack', totalCost: '2.50' },
  { id: 3, orderId: 3074, orderNumber: '3074', lineType: 'additional_unit', totalCost: '1.00' },
  { id: 2, orderId: 3074, orderNumber: '3074', lineType: 'package_cost', totalCost: '0.99' },
  { id: 1, orderId: 3074, orderNumber: '3074', lineType: 'shipping', totalCost: '7.95', selectedRateCost: '7.95' },
];
const RETURN: BillingDetailReadModelRow[] = [
  {
    id: 11, orderId: 3074, orderNumber: '3074', lineType: 'return_processing_fee',
    totalCost: '2.50', returnId: 77, returnReference: '3074-RETURN',
  },
  {
    id: 10, orderId: 3074, orderNumber: '3074', lineType: 'return_postage',
    totalCost: '8.05', returnId: 77, returnReference: '3074-RETURN',
    // No returnSelectedRateCost: the return has no proven shipment cost, which is the
    // case the fixture pins — Selected Rate and Margin must both stay blank.
  },
];

const rows = toBillingDetailOrderRows([...OUTBOUND, ...RETURN]);
const outbound = rows.find((r) => r.rowType !== 'Return');
const returnRow = rows.find((r) => r.rowType === 'Return');

console.log('PS-505 return economics guard\n');
console.log('#3074 outbound row');

check('one outbound row and one return row', () => {
  assert.equal(rows.length, 2, 'the return must not collapse into the outbound row');
  assert.ok(outbound, 'outbound row missing');
  assert.ok(returnRow, 'return row missing');
});

check('outbound components: 2.50 / 1.00 / 0.99 / 7.95', () => {
  assert.equal(money(outbound!.pickpackTotal), 2.5);
  assert.equal(money(outbound!.additionalTotal), 1.0);
  assert.equal(money(outbound!.packageTotal), 0.99);
  assert.equal(money(outbound!.shippingTotal), 7.95);
});

check('outbound fulfillment-service subtotal is 4.49', () => {
  // Pick & Pack + Additional Units + Box Cost. Shipping is a pass-through carrier
  // charge, not a fulfillment service.
  const subtotal = money(outbound!.pickpackTotal) + money(outbound!.additionalTotal)
    + money(outbound!.packageTotal);
  assert.equal(money(subtotal), 4.49);
});

check('outbound row total is 12.44', () => {
  assert.equal(money(outbound!.grandTotal), 12.44);
  assert.equal(money(outbound!.fulfillmentFeeTotal), 12.44);
});

check('outbound selected rate 7.95 and margin 0.00', () => {
  assert.equal(money(outbound!.selectedRateCost), 7.95);
  assert.equal(money(outbound!.margin), 0);
});

check('outbound row carries NO return money', () => {
  assert.equal(money(outbound!.returnPostageTotal), 0);
  assert.equal(money(outbound!.returnProcessingTotal), 0);
  assert.equal(money(outbound!.returnTotal), 0);
  assert.equal(outbound!.returnSelectedRateCost, null);
});

console.log('\n#3074-RETURN row');

check('return breakout: processing 2.50, postage 8.05', () => {
  assert.equal(money(returnRow!.returnProcessingTotal), 2.5);
  assert.equal(money(returnRow!.returnPostageTotal), 8.05);
  assert.equal(returnRow!.hasReturnProcessingLine, true);
  assert.equal(returnRow!.hasReturnPostageLine, true);
});

check('return total and row total are both 10.55', () => {
  assert.equal(money(returnRow!.returnTotal), 10.55);
  assert.equal(money(returnRow!.grandTotal), 10.55);
});

// THE load-bearing assertion. Before PS-505 the postage line also fed `shipping` and the
// processing line also fed `pickPack`, so this row reported 10.55 of Fulfillment Fee on
// top of its return columns — the same money twice, under two different names.
check('every outbound bucket on the return row is zero', () => {
  assert.equal(money(returnRow!.pickpackTotal), 0, 'return processing must not feed Pick & Pack');
  assert.equal(money(returnRow!.additionalTotal), 0);
  assert.equal(money(returnRow!.packageTotal), 0);
  assert.equal(money(returnRow!.shippingTotal), 0, 'return postage must not feed outbound Shipping');
  assert.equal(money(returnRow!.storageTotal), 0);
  assert.equal(
    money(returnRow!.fulfillmentFeeTotal), 0,
    'return money must never be reported as a Fulfillment Fee',
  );
});

check('return selected rate and margin are null, not zero', () => {
  assert.equal(returnRow!.selectedRateCost, null, 'unproven return cost must stay absent');
  assert.equal(returnRow!.returnSelectedRateCost, null);
  assert.equal(returnRow!.margin, null, 'a null cost cannot yield a numeric margin');
});

console.log('\nmargin ownership');

check('a proven return shipment cost yields a backend margin', () => {
  const withCost = toBillingDetailOrderRows([
    {
      id: 20, orderId: 3074, orderNumber: '3074', lineType: 'return_postage',
      totalCost: '8.05', returnId: 78, returnReference: '3074-RETURN-2',
      returnSelectedRateCost: '6.00',
    },
  ]);
  assert.equal(money(withCost[0]!.returnSelectedRateCost), 6);
  assert.equal(money(withCost[0]!.margin), 2.05, 'returnPostage 8.05 - proven cost 6.00');
});

check('an unknown outbound cost yields a null margin, never full-charge profit', () => {
  const noCost = toBillingDetailOrderRows([
    { id: 30, orderId: 900, orderNumber: '900', lineType: 'shipping', totalCost: '7.95' },
  ]);
  assert.equal(noCost[0]!.selectedRateCost, null);
  assert.equal(
    noCost[0]!.margin, null,
    'Number(null) === 0 would have reported the whole 7.95 charge as margin',
  );
});

console.log('\nlegacy vocabulary');

check('frozen legacy return spellings still carry money and stay out of outbound buckets', () => {
  for (const lineType of ['return_label', 'return_processing', 'return']) {
    const legacy = toBillingDetailOrderRows([
      {
        id: 40, orderId: 901, orderNumber: '901', lineType,
        totalCost: '5.00', returnId: 91, returnReference: '901-RETURN',
      },
    ]);
    const row = legacy[0]!;
    assert.equal(money(row.returnTotal), 5, `${lineType} must still count as return money`);
    assert.equal(money(row.grandTotal), 5, `${lineType} must still reach the row total`);
    assert.equal(money(row.shippingTotal), 0, `${lineType} must not feed outbound Shipping`);
    assert.equal(money(row.pickpackTotal), 0, `${lineType} must not feed Pick & Pack`);
  }
});

console.log('\ninvoice row-total fallback');

check('persisted nonzero row_total stays authoritative', () => {
  assert.equal(
    resolveBillingInvoiceRowTotal({
      rowTotal: '10.55', pickPackFee: 0, packageCost: 0, shipping: 0, storage: 0,
      returnPostage: '8.05', returnProcessing: '2.50',
    }),
    10.55,
    'return terms must not be added on top of a real row_total',
  );
});

check('zero-row fallback counts return money exactly once', () => {
  assert.equal(
    resolveBillingInvoiceRowTotal({
      rowTotal: '0', pickPackFee: 0, packageCost: 0, shipping: 0, storage: 0,
      returnPostage: '8.05', returnProcessing: '2.50',
    }),
    10.55,
    'a Return row with a zero persisted total exported as $0.00 before this',
  );
});

check('outbound zero-row fallback is unchanged', () => {
  assert.equal(
    resolveBillingInvoiceRowTotal({
      rowTotal: '0', pickPackFee: '3.50', packageCost: '0.99', shipping: '7.95', storage: 0,
    }),
    12.44,
  );
});

console.log('\nBilling Status removal');

check('no Billing Status column in the detail registry', () => {
  const ids = (BILLING_DETAIL_COLUMNS as BillingDetailColumn[]).map((c) => c.id);
  assert.ok(!ids.includes('billingStatus' as never), 'the standalone Status column must be gone');
  assert.ok(
    !(BILLING_DETAIL_COLUMNS as BillingDetailColumn[]).some((c) => c.label === 'Status'),
    'no column may be relabelled back into a Status column',
  );
});

check('Return Total column exists', () => {
  const ids = (BILLING_DETAIL_COLUMNS as BillingDetailColumn[]).map((c) => c.id);
  assert.ok(ids.includes('returnTotal' as never), 'a Return row needs a total of its own');
});

check('no Status column in the CSV invoice', () => {
  assert.ok(!INVOICE_CSV_HEADERS.includes('Status'), 'CSV must not export a Status column');
});

check('no Status column in the HTML or XLSX invoice', () => {
  const routes = readFileSync('src/routes/billing.ts', 'utf8');
  assert.ok(!routes.includes('<th>Status</th>'), 'HTML invoice still renders a Status header');
  assert.ok(
    !routes.includes("{ header: 'Status', key: 'status'"),
    'XLSX invoice still defines a Status column',
  );
  // Matches CODE, not prose: a property assignment or a read off the export row. A bare
  // substring test also matches the comment explaining why the field was removed, which
  // would make this assertion impossible to satisfy without deleting the explanation.
  assert.ok(
    !/^\s*billing_status_label\s*[:?]/m.test(routes),
    'billing_status_label must not be declared or assigned on the export row',
  );
  assert.ok(
    !/\bd\.billing_status_label\b/.test(routes),
    'no renderer may read billing_status_label off the export row',
  );
});

check('reconciliation serialization drops the status field', () => {
  const reconcile = readFileSync('src/routes/billing-invoice-reconcile.ts', 'utf8');
  assert.ok(!reconcile.includes('billing_status_label'));
});

check('the backend lifecycle owner is RETAINED', () => {
  // Removal is display/export only. The classifier still protects cancelled-no-charge
  // behaviour, Return styling and the review badges, so deleting it would be a
  // different and much larger change than this card authorises.
  const sot = readFileSync('src/services/billing-detail-row-sot.ts', 'utf8');
  assert.match(sot, /resolveBillingReturnRowStatus/, 'the Return row status owner must remain');
  const table = readFileSync('web/src/components/Views/BillingDetailTable.tsx', 'utf8');
  assert.match(table, /billingStatusLifecycle\(row\)/, 'row styling still consumes lifecycle facts');
});

check('the duplicate-order marker moved to the Order # cell', () => {
  const routes = readFileSync('src/routes/billing.ts', 'utf8');
  assert.match(
    routes,
    /duplicateLabel\s*\r?\n?\s*\?\s*`\$\{returnSuffixedOrderNumber\}/,
    'PS-491 duplicate marker must survive in the identity cell, not as a new Status column',
  );
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFAILURES');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PS-505 return economics guard passed.');
