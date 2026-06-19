/**
 * PS-296 — shipping margin analytics guard.
 *
 * Backend-owned read model:
 * - actual cost comes from shipments (cost/labelCost + otherCost)
 * - billable shipping comes from frozen billing_line_items.shipping when present
 * - projected rows must say which explicit source produced the projection
 * - UI/API are thin consumers; they must not own margin math
 *
 * Offline: pure helper imports + static wiring checks. No DB, no provider calls,
 * no live labels, no queue or shipped/cancelled mutation.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildShippingMarginAnalytics,
  buildShippingMarginRow,
  type ShippingMarginInputRow,
} from '../src/services/shipping-margin-analytics';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const frozenHouseRow = buildShippingMarginRow({
  clientId: 4,
  clientName: 'HUGRAB',
  shipmentId: 501,
  orderId: 1690,
  orderNumber: '1690',
  shipDate: '2026-06-19T00:00:00.000Z',
  shipmentCost: '6.00',
  shipmentLabelCost: '6.25',
  shipmentOtherCost: '1.00',
  billingLineItemId: 9001,
  billingTotalCost: '10.00',
  projectedBillableAmount: null,
  projectedBillableSource: null,
  houseCustomerRate: '10.00',
} satisfies ShippingMarginInputRow);
check('frozen row uses shipment cost + other cost as actual postage',
  frozenHouseRow.actualShippingCost === 7 &&
  frozenHouseRow.actualCostSource === 'shipments.cost_plus_other_cost');
check('frozen row uses billing_line_items.shipping as billable truth',
  frozenHouseRow.billableShippingAmount === 10 &&
  frozenHouseRow.billableSource === 'billing_line_items.shipping.total_cost' &&
  frozenHouseRow.state === 'frozen_billing');
check('frozen row computes margin and pct from backend-owned values',
  frozenHouseRow.marginAmount === 3 &&
  frozenHouseRow.marginPct === 42.86);
check('frozen row carries house provenance without exposing it as the billable source',
  frozenHouseRow.houseCustomerRate === 10);

const projectedHouseRow = buildShippingMarginRow({
  clientId: 4,
  clientName: 'HUGRAB',
  shipmentId: 502,
  orderId: 1691,
  orderNumber: '1691',
  shipDate: '2026-06-19T00:00:00.000Z',
  shipmentCost: null,
  shipmentLabelCost: '8.00',
  shipmentOtherCost: '0.50',
  billingLineItemId: null,
  billingTotalCost: null,
  projectedBillableAmount: null,
  projectedBillableSource: null,
  houseCustomerRate: '12.00',
} satisfies ShippingMarginInputRow);
check('projected house row uses explicit order_competitive_rate customer rate source',
  projectedHouseRow.state === 'projected' &&
  projectedHouseRow.billableShippingAmount === 12 &&
  projectedHouseRow.billableSource === 'order_competitive_rate.customer_rate' &&
  projectedHouseRow.actualCostSource === 'shipments.label_cost_plus_other_cost');

const missingBillableRow = buildShippingMarginRow({
  clientId: 5,
  clientName: 'Manual Orders',
  shipmentId: 503,
  orderId: 1692,
  orderNumber: '1692',
  shipDate: '2026-06-19T00:00:00.000Z',
  shipmentCost: null,
  shipmentLabelCost: null,
  shipmentOtherCost: null,
  billingLineItemId: null,
  billingTotalCost: null,
  projectedBillableAmount: null,
  projectedBillableSource: null,
  houseCustomerRate: null,
} satisfies ShippingMarginInputRow);
check('missing billable row is explicit and does not invent margin',
  missingBillableRow.state === 'missing_billable' &&
  missingBillableRow.actualShippingCost === null &&
  missingBillableRow.billableShippingAmount === null &&
  missingBillableRow.marginAmount === null);

const analytics = buildShippingMarginAnalytics([
  frozenHouseRow,
  projectedHouseRow,
  missingBillableRow,
], { dateFrom: '2026-06-01T00:00:00.000Z', dateTo: '2026-07-01T00:00:00.000Z' });
check('summary totals only aggregate rows with both actual and billable amounts',
  analytics.summary.rowCount === 3 &&
  analytics.summary.marginRowCount === 2 &&
  analytics.summary.actualShippingTotal === 15.5 &&
  analytics.summary.billableShippingTotal === 22 &&
  analytics.summary.marginTotal === 6.5 &&
  analytics.summary.marginPct === 41.94);
check('summary reports frozen/projected/missing counts separately',
  analytics.summary.frozenCount === 1 &&
  analytics.summary.projectedCount === 1 &&
  analytics.summary.missingBillableCount === 1);
check('summary groups client margins without UI math',
  analytics.clients.length === 2 &&
  analytics.clients[0]?.clientName === 'HUGRAB' &&
  analytics.clients[0]?.marginTotal === 6.5);

const serviceSrc = readText('src/services/shipping-margin-analytics.ts');
const billingRouteSrc = readText('src/routes/billing.ts');
const apiClientSrc = readText('web/src/lib/v2-apiClient.ts');
const billingViewSrc = readText('web/src/components/Views/BillingView.tsx');
const packageJson = readText('package.json');

check('service owns DB read model and reads shipments + billing line truth',
  serviceSrc.includes('export async function shippingMarginAnalytics') &&
  serviceSrc.includes('../db/schema/shipments') &&
  serviceSrc.includes('billingLineItems') &&
  serviceSrc.includes('orderCompetitiveRate'));
check('service does not mutate billing, orders, shipments, labels, or queue',
  !/\.insert\(|\.update\(|\.delete\(|createLabel|startQueueSendJob|addToQueue/.test(serviceSrc));
check('billing route exposes GET /shipping-margin behind financials read middleware',
  billingRouteSrc.includes("app.get('/shipping-margin'") &&
  billingRouteSrc.includes('shippingMarginAnalytics(withBillingScope'));
check('api client exposes fetchShippingMarginAnalytics as a thin billing API consumer',
  /fetchShippingMarginAnalytics\(/.test(apiClientSrc) &&
  apiClientSrc.includes('/billing/shipping-margin'));
check('BillingView consumes shipping margin analytics without computing margin itself',
  /fetchShippingMarginAnalytics\(/.test(billingViewSrc) &&
  /shippingMarginSummary/.test(billingViewSrc) &&
  !/billableShippingTotal\s*-\s*actualShippingTotal/.test(billingViewSrc));
check('package wires PS-296 guard',
  packageJson.includes('"test:ps-296-shipping-margin"'));

if (failures > 0) {
  console.error(`\nFAIL PS-296 shipping margin analytics guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-296 shipping margin analytics guard');
