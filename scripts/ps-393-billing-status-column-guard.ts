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

check('PS-393: CSV export includes backend status text near the left of each row', () => {
  assert.deepEqual(INVOICE_CSV_HEADERS.slice(0, 3), [
    'Ship Date/Time (Los Angeles)',
    'Order #',
    'Status',
  ]);
  const cells = renderInvoiceCsvRow(baseCsvRow()).split(',');
  assert.equal(cells[2], 'Cancelled \u00b7 No charge');
});

check('PS-393: UI exposes a default-visible Billing Status column after Order #', () => {
  const parity = read('web/src/components/Views/billing-parity.ts');
  assert.ok(parity.includes("| 'billingStatus'"), 'missing BillingDetailColumnId billingStatus');
  assert.ok(
    /orderNumber'[\s\S]{0,180}billingStatus'[\s\S]{0,180}shipDate'/.test(parity),
    'Billing Status must be ordered between Order # and Ship Date',
  );
  assert.ok(/DEFAULT_BILLING_DETAIL_COLUMN_IDS[\s\S]{0,120}'billingStatus'/.test(parity));
  assert.ok(/billing_detail_cols_v6/.test(parity), 'column storage key must reset to v6');
});

check('PS-393: BillingDetailTable renders backend status label and row treatment', () => {
  const table = read('web/src/components/Views/BillingDetailTable.tsx');
  assert.ok(/case 'billingStatus'/.test(table), 'missing Billing Status render case');
  assert.ok(/billingStatusLabel/.test(table), 'table must render backend billingStatusLabel');
  assert.ok(/billingLifecycleStatus/.test(table), 'table must key row treatment off backend lifecycle');
  assert.ok(!/row\.orderStatus === 'cancelled'/.test(table), 'FE must not infer status from orderStatus');
});

check('PS-393: invoice HTML and XLSX exports include Status from billingInvoiceData details', () => {
  const route = read('src/routes/billing.ts');
  assert.ok(/billing_status_label/.test(route), 'billingInvoiceData must populate billing_status_label');
  assert.ok(/<th>Status<\/th>/.test(route), 'HTML invoice must include Status header');
  assert.ok(/escHtml\(d\.billing_status_label/.test(route), 'HTML invoice row must render status text');
  assert.ok(/header:\s*'Status',\s*key:\s*'status'/.test(route), 'XLSX invoice must include Status column');
  assert.ok(/status:\s*d\.billing_status_label/.test(route), 'XLSX rows must write status text');
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
