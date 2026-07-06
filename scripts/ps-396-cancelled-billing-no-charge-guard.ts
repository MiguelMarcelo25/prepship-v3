/**
 * PS-396 - cancelled Billing rows are visible audit rows, but fully no-charge.
 *
 * Per user override unlock shipped data on 2026-07-06: this guard covers the
 * cancelled Billing read model only. It performs no DB writes, no order/shipment
 * mutation, no label/postage purchase, and no marketplace notification.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';
import { resolveBillingRowStatus } from '../src/services/billing-row-status';

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

check('PS-396: cancelled positive/stale rows still resolve to no-charge status', () => {
  const status = resolveBillingRowStatus({
    lineType: 'pick_pack',
    orderStatus: 'cancelled',
    totalCost: '2.50',
    packageCostNeedsReview: true,
    shippingZeroNeedsReview: true,
  });
  assert.equal(status.billingLifecycleStatus, 'cancelled_no_charge');
  assert.equal(status.billingStatusLabel, 'Cancelled \u00b7 No charge');
  assert.equal(status.billingZeroReason, 'cancelled');
  assert.equal(status.billingStatusBadge, 'CANCELLED');
});

check('PS-396: American canceled spelling is normalized to cancelled no-charge', () => {
  const status = resolveBillingRowStatus({
    lineType: 'shipping',
    orderStatus: 'canceled',
    totalCost: '8.17',
  });
  assert.equal(status.billingLifecycleStatus, 'cancelled_no_charge');
  assert.equal(status.billingStatusLabel, 'Cancelled \u00b7 No charge');
});

check('PS-396: return lines stay separate and are not zeroed by cancelled lifecycle', () => {
  const status = resolveBillingRowStatus({
    lineType: 'return_label',
    orderStatus: 'cancelled',
    totalCost: '4.25',
  });
  assert.equal(status.billingLifecycleStatus, 'return_label');
  assert.equal(status.billingStatusLabel, 'Return label');
  assert.equal(status.billingZeroReason, null);
});

check('PS-396: grouped detail DTO zeroes stale cancelled charges and review noise', () => {
  const [row] = toBillingDetailOrderRows([
    {
      orderId: 396,
      orderNumber: '1340',
      lineType: 'pick_pack',
      totalCost: '2.50',
      billingLifecycleStatus: 'cancelled_no_charge',
      billingStatusLabel: 'Cancelled \u00b7 No charge',
      billingStatusTone: 'red',
      billingZeroReason: 'cancelled',
      billingStatusBadge: 'CANCELLED',
    },
    {
      orderId: 396,
      orderNumber: '1340',
      lineType: 'package_cost_missing',
      totalCost: '0.00',
      packageCostNeedsReview: true,
      boxCostAlert: true,
      billingBadges: ['NO_BOX_COST'],
      billingLifecycleStatus: 'cancelled_no_charge',
      billingStatusLabel: 'Cancelled \u00b7 No charge',
      billingStatusTone: 'red',
      billingZeroReason: 'cancelled',
      billingStatusBadge: 'CANCELLED',
    },
    {
      orderId: 396,
      orderNumber: '1340',
      lineType: 'shipping',
      totalCost: '0.00',
      shippingZeroNeedsReview: true,
      zeroShippingReviewReason: 'cancelled_or_not_shipped',
      zeroShippingReviewLabel: 'Cancelled - review prep fee',
      billingLifecycleStatus: 'cancelled_no_charge',
      billingStatusLabel: 'Cancelled \u00b7 No charge',
      billingStatusTone: 'red',
      billingZeroReason: 'cancelled',
      billingStatusBadge: 'CANCELLED',
    },
  ]);

  assert.equal(row.pickpackTotal, 0);
  assert.equal(row.additionalTotal, 0);
  assert.equal(row.packageTotal, 0);
  assert.equal(row.shippingTotal, 0);
  assert.equal(row.fulfillmentFeeTotal, 0);
  assert.equal(row.grandTotal, 0);
  assert.equal(row.packageCostNeedsReview === true, false);
  assert.equal(row.shippingZeroNeedsReview === true, false);
  assert.equal(row.boxCostAlert, false);
  assert.equal((row.billingBadges as string[] | undefined)?.includes('NO_BOX_COST'), false);
  assert.equal(row.billingStatusLabel, 'Cancelled \u00b7 No charge');
  assert.equal(row.billingStatusBadge, 'CANCELLED');
});

check('PS-396: generator uses lifecycle no-charge policy without a HUGRAB billable exception', () => {
  const billing = read('src/services/billing.ts');
  assert.ok(/isCancelledBillingStatus\(/.test(billing), 'generator must delegate to cancelled status policy');
  assert.ok(
    !/HUGRAB_CANCELLED_BILLING_CLIENT_NAME/.test(billing),
    'PS-396 removes the prior HUGRAB billable-cancelled exception',
  );
  assert.ok(/lineType:\s*'cancelled'[\s\S]*?totalCost:\s*'0\.00'/.test(billing));
});

check('PS-396: summary, invoice header, and invoice detail aggregates zero stale cancelled source lines', () => {
  const billing = read('src/services/billing.ts');
  const route = read('src/routes/billing.ts');
  const reporting = read('src/services/reporting-metrics.ts');
  assert.ok(
    (billing.match(/cancelledNoChargeBillingAmountSql/g) ?? []).length >= 2,
    'billing summary and invoice header totals must use the no-charge SQL amount helper',
  );
  assert.ok(
    (route.match(/cancelledNoChargeBillingAmountSql/g) ?? []).length >= 1,
    'invoice detail aggregates must use the no-charge SQL amount helper',
  );
  assert.ok(
    (reporting.match(/cancelledNoChargeBillingAmountSql/g) ?? []).length >= 1,
    'billing_summary_metrics refresh must use the no-charge SQL amount helper',
  );
});

check('PS-396: safety pins no source-table shipped/cancelled mutation', () => {
  const billing = read('src/services/billing.ts');
  const detailSot = read('src/services/billing-detail-row-sot.ts');
  assert.ok(!/\.update\(orders\)/.test(billing) && !/\.update\(shipments\)/.test(billing));
  assert.ok(!/delete\(orders\)/.test(billing) && !/delete\(shipments\)/.test(billing));
  assert.ok(!/\.update\(orders\)/.test(detailSot) && !/\.update\(shipments\)/.test(detailSot));
});

check('PS-396: package exposes focused guard', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(
    packageJson.scripts?.['test:ps-396-cancelled-billing-no-charge'],
    'tsx scripts/ps-396-cancelled-billing-no-charge-guard.ts',
  );
});

if (failures > 0) {
  console.error(`\nFAIL PS-396 cancelled billing no-charge guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-396 cancelled billing no-charge guard');
