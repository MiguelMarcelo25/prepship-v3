/**
 * PS-393 - Billing status column for cancelled no-charge rows and returns.
 *
 * Offline guard: no DB writes, no labels, no production mutation. It pins the
 * backend-owned status contract that Billing detail rows and invoice exports
 * consume verbatim.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  INVOICE_CSV_HEADERS,
  renderInvoiceCsvRow,
  type InvoiceCsvDetailRow,
} from '../src/routes/billing-invoice-csv';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';
import {
  resolveBillingRowStatus,
  type BillingRowStatusResult,
} from '../src/services/billing-row-status';
// Import the header constant rather than restating its text. PS-434 renamed it
// from 'Ship Date/Time (Los Angeles)' to 'Billing / Activity Date (Los Angeles)'
// when it split actual activity day from billing effective day, and this guard
// broke on the wording. What PS-393 owns is the COLUMN ORDER -- status text near
// the left of each row -- not the first column's label.
import { INVOICE_SHIP_DATE_HEADER } from '../src/routes/billing-invoice-text';

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

const read = (path: string) => readFileSync(path, 'utf8');

function baseCsvRow(overrides: Partial<InvoiceCsvDetailRow> = {}): InvoiceCsvDetailRow {
  return {
    order_id: 393,
    order_number: 'PS393',
    ship_date: '2026-07-06',
    base_qty: '1',
    addl_qty: '0',
    pickpack_amt: '0',
    additional_amt: '0',
    shipping_amt: '0',
    storage_amt: '0',
    row_total: '0',
    skus: 'SKU-393',
    package_cost_amt: '0',
    box_label: 'No box',
    box_review: false,
    fee_waived: false,
    billing_status_label: 'Cancelled \u00b7 No charge',
    ...overrides,
  };
}

check('PS-393: backend status owner maps cancelled no-charge rows explicitly', () => {
  const status: BillingRowStatusResult = resolveBillingRowStatus({
    lineType: 'cancelled',
    orderStatus: 'cancelled',
    totalCost: '0.00',
  });
  assert.equal(status.billingLifecycleStatus, 'cancelled_no_charge');
  assert.equal(status.billingStatusLabel, 'Cancelled \u00b7 No charge');
  assert.equal(status.billingStatusTone, 'red');
  assert.equal(status.billingZeroReason, 'cancelled');
  assert.equal(status.billingStatusBadge, 'CANCELLED');
});

check('PS-393: backend status owner maps return line items without mutating original fulfillment', () => {
  const status = resolveBillingRowStatus({
    lineType: 'return_label',
    orderStatus: 'shipped',
    totalCost: '4.25',
  });
  assert.equal(status.billingLifecycleStatus, 'return_label');
  assert.equal(status.billingStatusLabel, 'Return label');
  assert.equal(status.billingStatusTone, 'purple');
  assert.equal(status.billingZeroReason, null);
});

check('PS-393: return charges stay separate from the original fulfillment row', () => {
  const rows = toBillingDetailOrderRows([
    {
      id: 1,
      orderId: 393,
      orderNumber: 'R393',
      lineType: 'shipping',
      totalCost: '6.00',
      billingLifecycleStatus: 'fulfilled',
      billingStatusLabel: 'Fulfilled',
      billingStatusTone: 'neutral',
      billingZeroReason: null,
    },
    {
      id: 2,
      orderId: 393,
      orderNumber: 'R393',
      lineType: 'return_label',
      totalCost: '4.25',
      billingLifecycleStatus: 'return_label',
      billingStatusLabel: 'Return label',
      billingStatusTone: 'purple',
      billingZeroReason: null,
    },
  ]);
  assert.equal(rows.length, 2, 'return charge must not collapse into the fulfillment row');
  assert.equal(rows.find((row) => row.billingLifecycleStatus === 'fulfilled')?.shippingTotal, 6);
  assert.equal(rows.find((row) => row.billingLifecycleStatus === 'return_label')?.billingStatusLabel, 'Return label');
});

check('PS-393: collapsed detail DTO carries explicit status fields and keeps cancelled dollars at zero', () => {
  const [dto] = toBillingDetailOrderRows([
    {
      orderId: 393,
      orderNumber: 'C393',
      lineType: 'cancelled',
      totalCost: '0.00',
      billingLifecycleStatus: 'cancelled_no_charge',
      billingStatusLabel: 'Cancelled \u00b7 No charge',
      billingStatusTone: 'red',
      billingZeroReason: 'cancelled',
      billingStatusBadge: 'CANCELLED',
    },
  ]);
  assert.equal(dto.grandTotal, 0);
  assert.equal(dto.fulfillmentFeeTotal, 0);
  assert.equal(dto.billingLifecycleStatus, 'cancelled_no_charge');
  assert.equal(dto.billingStatusLabel, 'Cancelled \u00b7 No charge');
  assert.equal(dto.billingStatusTone, 'red');
  assert.equal(dto.billingZeroReason, 'cancelled');
});

// \u2500\u2500 PS-505 INVERTED THE FOUR COLUMN CHECKS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// PS-393 shipped a Billing Status column across the detail table and all three invoice
// renderers. PS-505 removes that column as a deliberate capability removal \u2014 NOT because
// the classification was wrong. The backend owner (billing-row-status.ts) is retained and
// its facts still drive cancelled-no-charge behaviour, Return classification, review
// conditions and row styling; every one of those is still pinned by the checks above and
// below, which is why this guard survives rather than being deleted.
//
// These four are inverted rather than removed so the guard now ratchets the OTHER way: a
// future change that reintroduces a Status column, in any of the four surfaces, fails
// here instead of silently undoing the card.

check('PS-505: CSV export carries NO Status column', () => {
  assert.deepEqual(INVOICE_CSV_HEADERS.slice(0, 3), [
    INVOICE_SHIP_DATE_HEADER,
    'Order #',
    'SKUs',
  ]);
  assert.ok(!INVOICE_CSV_HEADERS.includes('Status'), 'Status must not reappear in the CSV');
  // The cell that used to hold status text is now the SKUs cell.
  const cells = renderInvoiceCsvRow(baseCsvRow()).split(',');
  assert.notEqual(cells[2], 'Cancelled \u00b7 No charge', 'status text must not survive positionally');
});

check('PS-505: the UI exposes NO Billing Status column', () => {
  const parity = read('web/src/components/Views/billing-parity.ts');
  assert.ok(!parity.includes("| 'billingStatus'"), 'BillingDetailColumnId must not carry billingStatus');
  assert.ok(
    !/DEFAULT_BILLING_DETAIL_COLUMN_IDS[\s\S]{0,400}'billingStatus'/.test(parity),
    'billingStatus must not be a default column',
  );
  assert.ok(
    !/\{\s*id:\s*'billingStatus'/.test(parity),
    'no column definition may declare billingStatus',
  );
  // Unchanged from PS-393: the key must stay VERSIONED and never regress below the reset
  // PS-393 introduced. PS-505 bumped it to v8, which is the correct action \u2014 removing a
  // column leaves a stale id in every operator's saved config until the key changes.
  const colsKey = /billing_detail_cols_v(\d+)/.exec(parity);
  assert.ok(colsKey, 'column storage key must stay versioned (billing_detail_cols_vN)');
  assert.ok(
    Number(colsKey[1]) >= 6,
    `column storage key must not regress below the PS-393 reset (found v${colsKey[1]})`,
  );
});

check('PS-505: the table drops the Status cell but KEEPS backend lifecycle facts', () => {
  const table = read('web/src/components/Views/BillingDetailTable.tsx');
  assert.ok(!/case 'billingStatus'/.test(table), 'the Billing Status render case must be gone');
  // Retained on purpose \u2014 removal is display-only. Row treatment, the cancelled/return
  // classes and the essential badges all still consume the backend classification.
  assert.ok(/billingStatusLifecycle/.test(table), 'row treatment must still key off backend lifecycle');
  assert.ok(/billingStatusLabel/.test(table), 'badges must still read the backend label');
  assert.ok(!/row\.orderStatus === 'cancelled'/.test(table), 'FE must not infer status from orderStatus');
});

check('PS-505: HTML and XLSX invoices carry NO Status column', () => {
  const route = read('src/routes/billing.ts');
  assert.ok(!/^\s*billing_status_label\s*[:?]/m.test(route), 'the export row must not declare it');
  assert.ok(!/\bd\.billing_status_label\b/.test(route), 'no renderer may read it');
  assert.ok(!/<th>Status<\/th>/.test(route), 'HTML invoice must not include a Status header');
  assert.ok(!/header:\s*'Status',\s*key:\s*'status'/.test(route), 'XLSX must not include a Status column');
});

check('PS-393: safety pins no source-table shipped/cancelled mutation in status work', () => {
  const billing = read('src/services/billing.ts');
  assert.ok(!/\.update\(orders\)/.test(billing) && !/\.update\(shipments\)/.test(billing));
  assert.ok(!/delete\(orders\)/.test(billing) && !/delete\(shipments\)/.test(billing));
});

check('PS-393: package exposes focused guard', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(
    packageJson.scripts?.['test:ps-393-billing-status-column'],
    'tsx scripts/ps-393-billing-status-column-guard.ts',
  );
});

check('PS-393: missing return billing source of truth is documented before return fees ship', () => {
  assert.ok(
    existsSync('docs/ps-393-return-billing-follow-up.md'),
    'document the missing return billing SOT before adding return fees',
  );
});

if (failures > 0) {
  console.error(`\nFAIL PS-393 billing status column guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-393 billing status column guard');
