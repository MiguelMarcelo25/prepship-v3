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

// THE assertion the first attempt got wrong. It asserted fulfillmentFeeTotal === 12.44,
// which locked the defect in: Fulfillment Fee is the fulfillment SERVICE work only, and
// the column labelled "Fulfillment Fee" was therefore rendering the row total. Shipping
// is a pass-through carrier charge; Storage is a separate service. Neither is a
// fulfillment fee.
check('outbound Fulfillment Fee is 4.49 — services only, NOT the row total', () => {
  assert.equal(
    money(outbound!.fulfillmentFeeTotal), 4.49,
    'Pick & Pack 2.50 + Additional 1.00 + Box 0.99 — no shipping, no storage',
  );
});

check('outbound Row Total is 12.44 — Fulfillment Fee + shipping', () => {
  assert.equal(money(outbound!.grandTotal), 12.44);
  // money() the SUM, not just the terms: 4.49 + 7.95 is 12.440000000000001 in IEEE754,
  // which is exactly the class of artifact the backend margin rounding also exists for.
  assert.equal(
    money(money(outbound!.fulfillmentFeeTotal) + money(outbound!.shippingTotal)), 12.44,
    'the two concepts must compose into the row total',
  );
});

check('Fulfillment Fee and Row Total are DIFFERENT numbers on #3074', () => {
  // The whole defect in one assertion: if these are ever equal on a row that has
  // shipping, the two concepts have collapsed back into one.
  assert.notEqual(
    money(outbound!.fulfillmentFeeTotal), money(outbound!.grandTotal),
    'a row with shipping must not report the same value for both',
  );
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

check('return total and row total are both 10.55, Fulfillment Fee is 0', () => {
  assert.equal(money(returnRow!.returnTotal), 10.55);
  assert.equal(money(returnRow!.grandTotal), 10.55);
  assert.equal(
    money(returnRow!.fulfillmentFeeTotal), 0,
    'a return performs no fulfillment service work',
  );
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

console.log('\nHUGRAB integrated economics (policy owner -> PS-505 margin projection)');

// Hermes's correction: PS-437 already proves the canonical customer-shipping policy
// produces $6.77, so that calculation is NOT duplicated here. What this connects is the
// policy owner's OUTPUT to the backend-owned PS-505 margin projection — the seam neither
// guard covered on its own. Run alongside `npm run test:ps-437-customer-shipping-money`,
// which owns the policy proof itself.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret';
const { resolveCustomerShippingMoney } = await import('../src/services/customer-shipping-money.js');

check('$5.58 proven cost -> policy $6.77 postage -> backend margin exactly $1.19', () => {
  // The customer rate comes FROM the policy owner, not from a literal in this file.
  const policy = resolveCustomerShippingMoney({
    selectedRateCost: 5.58,
    billingMode: 'per_shipment',
    carrierCode: 'stamps_com',
    hugrabShippingRateOverride: { enabled: true, threshold: 6, amount: 6.77 },
  });
  assert.equal(policy.cShippingRateAmount, 6.77, 'policy owner must decide the customer rate');

  const [row] = toBillingDetailOrderRows([
    {
      id: 60, orderId: 3074, orderNumber: '3074', lineType: 'return_postage',
      totalCost: String(policy.cShippingRateAmount), returnId: 79,
      returnReference: '3074-RETURN-HUGRAB',
      returnSelectedRateCost: String(policy.selectedRateCost),
    },
  ]);

  assert.equal(money(row!.returnPostageTotal), 6.77, 'customer postage');
  assert.equal(money(row!.returnSelectedRateCost), 5.58, 'proven return cost');
  // Exactly 1.19, not 1.1900000000000004. Routed through the backend money owner.
  assert.equal(
    row!.margin, 1.19,
    'margin must be money-rounded at the owner, not a float subtraction',
  );
  assert.equal(money(row!.fulfillmentFeeTotal), 0, 'Fulfillment Fee blank/zero on a return');
  assert.equal(money(row!.shippingTotal), 0, 'outbound Shipping blank/zero on a return');
  assert.equal(money(row!.grandTotal), 6.77, 'row total is the return money');
});

check('margin needs BOTH facts — an absent postage line yields null even with a cost', () => {
  const [row] = toBillingDetailOrderRows([
    {
      id: 61, orderId: 3074, orderNumber: '3074', lineType: 'return_processing_fee',
      totalCost: '2.50', returnId: 80, returnReference: '3074-RETURN-NOPOSTAGE',
      returnSelectedRateCost: '5.58',
    },
  ]);
  assert.equal(row!.hasReturnPostageLine, false);
  assert.equal(
    row!.margin, null,
    'no postage charge exists, so there is nothing for the cost to be a margin against',
  );
});

check('an explicit ZERO on either side is a fact and still yields a margin', () => {
  const [row] = toBillingDetailOrderRows([
    {
      id: 62, orderId: 3074, orderNumber: '3074', lineType: 'return_postage',
      totalCost: '6.77', returnId: 81, returnReference: '3074-RETURN-ZEROCOST',
      returnSelectedRateCost: '0',
    },
  ]);
  assert.equal(row!.returnSelectedRateCost, 0, 'explicit zero is a proven cost, not absence');
  assert.equal(row!.margin, 6.77, 'a free return label is 100% margin, and that is a real answer');
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

check('THREE distinct money columns exist, none overloaded', () => {
  const cols = BILLING_DETAIL_COLUMNS as BillingDetailColumn[];
  const ids = cols.map((c) => c.id);
  assert.ok(ids.includes('total' as never), 'Fulfillment Fee column');
  assert.ok(ids.includes('returnTotal' as never), 'Return Total column');
  assert.ok(ids.includes('rowTotal' as never), 'Row Total column');
  assert.equal(
    cols.find((c) => c.id === 'total')?.label, 'Fulfillment Fee',
    'the services column keeps its name',
  );
  assert.equal(cols.find((c) => c.id === 'rowTotal')?.label, 'Row Total');
});

check('each money column sorts and foots on the concept it renders', () => {
  const table = readFileSync('web/src/components/Views/BillingDetailTable.tsx', 'utf8');
  // The footer defect: the Fulfillment Fee column's cells rendered fulfillmentFee while
  // its footer rendered detailTotals.total — two concepts under one heading.
  assert.match(
    table,
    /case 'total': return <td[^>]*>\{formatBillingMoney\(detailTotals\.fulfillmentFee\)\}/,
    'Fulfillment Fee footer must sum fulfillmentFee, not the row total',
  );
  assert.match(
    table,
    /case 'rowTotal': return <td[^>]*>\{formatBillingMoney\(detailTotals\.total\)\}/,
    'Row Total footer must sum the row total',
  );
  assert.match(table, /case 'total': return metrics\.fulfillmentFee/, 'sort matches the cell');
  assert.match(table, /case 'rowTotal': return metrics\.total/, 'sort matches the cell');
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
    /duplicateLabel\s*\r?\n?\s*\?\s*`\$\{baseOrderNumber\}/,
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
