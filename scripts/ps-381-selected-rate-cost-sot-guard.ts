/**
 * PS-381 - Backfill/enforce shipments.selected_rate_cost SOT.
 *
 * Pure/offline: no DB connection, no provider calls, no labels/postage, no
 * production shipped/cancelled mutation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'guard-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'guard-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'guard-jwt-secret';

const { resolveBillingSelectedRateCost } = await import('../src/services/billing-selected-rate-cost');
const { buildShippingMarginRow } = await import('../src/services/shipping-margin-analytics');
const {
  planSelectedRateCostBackfillRow,
  summarizeSelectedRateCostBackfill,
} = await import('../src/services/shipping-workflow/selected-rate-cost-backfill');

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

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

check('backfill writes durable selected-rate JSON total when no postage component exists', () => {
  const plan = planSelectedRateCostBackfillRow({
    shipmentId: 38101,
    orderNumber: 'PS-381-A',
    cost: null,
    labelCost: null,
    otherCost: '0.00',
    selectedRateJson: { totalCost: 12.34, shipmentCost: 12.34 },
    selectedRateCost: null,
  });
  assert.deepEqual(plan, {
    shipmentId: 38101,
    orderNumber: 'PS-381-A',
    affected: true,
    value: 12.34,
    skipReason: null,
  });
});

check('backfill writes postage plus other/insurance when postage proof exists', () => {
  const plan = planSelectedRateCostBackfillRow({
    shipmentId: 38102,
    orderNumber: 'PS-381-B',
    cost: '8.39',
    labelCost: null,
    otherCost: '4.59',
    selectedRateJson: { shipmentCost: 8.39, otherCost: 4.59, totalCost: 12.98 },
    selectedRateCost: null,
  });
  assert.equal(plan.affected, true);
  assert.equal(plan.value, 12.98);
});

check('backfill leaves rows without durable cost proof null', () => {
  const plan = planSelectedRateCostBackfillRow({
    shipmentId: 38103,
    orderNumber: 'PS-381-C',
    cost: null,
    labelCost: null,
    otherCost: '0.00',
    selectedRateJson: { carrierCode: 'ups_ground' },
    selectedRateCost: null,
  });
  assert.equal(plan.affected, false);
  assert.equal(plan.value, null);
  assert.equal(plan.skipReason, 'no_recorded_cost');
});

check('backfill remains idempotent for rows already carrying selected_rate_cost', () => {
  const plan = planSelectedRateCostBackfillRow({
    shipmentId: 38104,
    orderNumber: 'PS-381-D',
    cost: '999.99',
    labelCost: '999.99',
    otherCost: '99.99',
    selectedRateJson: { totalCost: 12.98 },
    selectedRateCost: '12.98',
  });
  assert.equal(plan.affected, false);
  assert.equal(plan.skipReason, 'already_set');
});

check('summary counts JSON-total and postage proof rows as affected, missing proof as skipped', () => {
  const plans = [
    planSelectedRateCostBackfillRow({
      shipmentId: 1,
      orderNumber: null,
      cost: null,
      labelCost: null,
      otherCost: null,
      selectedRateJson: { totalCost: 7.25 },
      selectedRateCost: null,
    }),
    planSelectedRateCostBackfillRow({
      shipmentId: 2,
      orderNumber: null,
      cost: '5.00',
      labelCost: null,
      otherCost: '1.00',
      selectedRateJson: null,
      selectedRateCost: null,
    }),
    planSelectedRateCostBackfillRow({
      shipmentId: 3,
      orderNumber: null,
      cost: null,
      labelCost: null,
      otherCost: null,
      selectedRateJson: null,
      selectedRateCost: null,
    }),
  ];
  assert.deepEqual(summarizeSelectedRateCostBackfill(plans), {
    total: 3,
    affected: 2,
    alreadySet: 0,
    noRecordedCost: 1,
    readerDivergent: 0,
  });
});

check('resolver still treats selected-rate JSON total as durable proof', () => {
  assert.equal(
    resolveBillingSelectedRateCost({
      selectedRateCost: null,
      cost: null,
      labelCost: null,
      otherCost: null,
      selectedRateJson: { totalCost: 12.34 },
    }),
    12.34,
  );
});

check('shipping margin actual cost delegates to selected_rate_cost before component fallbacks', () => {
  const row = buildShippingMarginRow({
    clientId: 1,
    clientName: 'Client',
    shipmentId: 10,
    orderId: 20,
    orderNumber: 'PS-381-M',
    shipDate: '2026-07-01T00:00:00.000Z',
    shipmentCost: '999.99',
    shipmentLabelCost: '888.88',
    shipmentOtherCost: '7.77',
    selectedRateCost: '12.98',
    selectedRateJson: { totalCost: 12.98 },
    billingLineItemId: 30,
    billingTotalCost: '15.00',
    projectedBillableAmount: null,
    projectedBillableSource: null,
    cShippingRateAmount: null,
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    providerAccountId: 123,
    providerAccountNickname: 'ORION',
  } as any);
  assert.equal(row.actualShippingCost, 12.98);
  assert.equal(row.actualCostSource, 'shipments.selected_rate_cost');
});

const billing = read('src/services/billing.ts');
const margin = read('src/services/shipping-margin-analytics.ts');
const labels = read('src/services/labels.ts');
const sync = read('src/services/shipment-sync.ts');
const backfillScript = read('scripts/ps-370-selected-rate-cost-backfill.ts');

check('billing generator delegates selected shipping cost to resolver with selectedRateJson', () => {
  assert.match(billing, /const labelCost = resolveBillingSelectedRateCost\(\{/);
  assert.match(billing, /selectedRateCost: s\.selectedRateCost/);
  assert.match(billing, /selectedRateJson: s\.selectedRateJson/);
  assert.doesNotMatch(billing, /const persistedSelectedRateCost = toFiniteNumber\(s\.selectedRateCost\)/);
});

check('shipping margin SQL reads selected_rate_cost and selected_rate_json into the row owner', () => {
  assert.match(margin, /selectedRateCost/);
  assert.match(margin, /selectedRateJson/);
  assert.match(margin, /resolveBillingSelectedRateCost/);
});

check('shipment writers stamp selectedRateCost anywhere durable proof exists', () => {
  assert.match(labels, /selectedRateCost: label\.shipment_cost\.amount\.toFixed\(2\)/);
  assert.match(labels, /selectedRateCost: '0\.00'/);
  // Repointed 2026-08-04: `result.cost` became `durableResult.cost` when the
  // durable receipt-resume path was added and the local was renamed to
  // distinguish it from the live purchase result (labels.ts:3901). Same stamp,
  // same toFixed(2), different local. The other three clauses here still match
  // verbatim, which is what isolated this to a rename rather than a lost stamp.
  assert.match(labels, /selectedRateCost: \w*[Rr]esult\.cost\.toFixed\(2\)/);
  assert.match(sync, /values\.otherCost = toNumeric\(s\.insuranceCost\) \?\? '0\.00'/);
  assert.match(sync, /values\.selectedRateCost = resolveBillingSelectedRateCost\(/);
});

check('backfill script documents the current 2026-07-06 shipped-data override and remains double-gated', () => {
  assert.match(backfillScript, /Per user override unlock shipped data on 2026-07-06/);
  assert.match(backfillScript, /--apply/);
  assert.match(backfillScript, /--confirm-production/);
  assert.match(backfillScript, /\.where\(and\(eq\(shipments\.id, plan\.shipmentId\), isNull\(shipments\.selectedRateCost\)\)\)/);
});

if (failures > 0) {
  console.error(`\nFAIL PS-381 selected-rate-cost SOT guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-381 selected-rate-cost SOT guard');
