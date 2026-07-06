/**
 * PS-392 - Manual Billing edits must survive regeneration.
 *
 * Offline guard: no DB writes, no labels, no production mutation. It pins the
 * backend source-of-truth placement for manual Billing overrides:
 *
 * - operator edits enter at PATCH /billing/details/:orderId
 * - pick/pack, additional units, and customer-billed shipping are persisted in
 *   a durable backend override owner before generated line items are rebuilt
 * - Box Cost remains owned by billing_box_resolutions
 * - shipping overrides never mutate selected/purchased shipment cost fields
 * - admin detail rows carry backend override markers that the UI only renders
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'guard-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'guard-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'guard-jwt-secret';

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>)
        .then(() => console.log(`ok   ${name}`))
        .catch((err) => {
          failures += 1;
          console.error(`FAIL ${name} - ${err instanceof Error ? err.message : err}`);
        });
    }
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name} - ${err instanceof Error ? err.message : err}`);
  }
}

const read = (path: string) => readFileSync(path, 'utf8');
const readIfExists = (path: string) => existsSync(path) ? read(path) : '';

const route = read('src/routes/billing.ts');
const billingService = read('src/services/billing.ts');
const detailSot = read('src/services/billing-detail-row-sot.ts');
const detailTable = read('web/src/components/Views/BillingDetailTable.tsx');
const editModal = read('web/src/components/Views/BillingEditDetailModal.tsx');
const packageJson = JSON.parse(read('package.json'));
const manualStorePath = 'src/services/billing-manual-overrides.ts';
const manualStore = readIfExists(manualStorePath);

const patchStart = route.indexOf("app.patch('/details/:orderId");
const patchEnd = route.indexOf('return c.json({ ok: true', patchStart);
const patchBlock =
  patchStart >= 0 && patchEnd > patchStart
    ? route.slice(patchStart, route.indexOf('});', patchEnd) + 3)
    : '';

check('PS-392: durable manual override owner exists', () => {
  assert.ok(existsSync(manualStorePath), 'missing src/services/billing-manual-overrides.ts');
});

check('PS-392: manual override owner owns additive schema + read/upsert/apply API', () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS billing_manual_overrides/.test(manualStore));
  assert.ok(/ensureBillingManualOverridesSchema/.test(manualStore));
  assert.ok(/readBillingManualOverrides/.test(manualStore));
  assert.ok(/upsertBillingManualOverride/.test(manualStore));
  assert.ok(/applyManualBillingOverrides/.test(manualStore));
});

check('PS-392: manual override owner covers pick_pack, additional_unit, and shipping only', () => {
  assert.ok(/pick_pack/.test(manualStore));
  assert.ok(/additional_unit/.test(manualStore));
  assert.ok(/shipping/.test(manualStore));
  assert.ok(!/MANUAL_BILLING_OVERRIDE_LINE_TYPES[\s\S]{0,300}package_cost/.test(manualStore),
    'package_cost must stay with billing_box_resolutions');
});

check('PS-392: details PATCH writes manual overrides inside the edit transaction', () => {
  assert.ok(/ensureBillingManualOverridesSchema\(\)/.test(patchBlock));
  assert.ok(/await db\.transaction\(async \(tx\) =>/.test(patchBlock));
  assert.ok(/upsertBillingManualOverride\([\s\S]*tx/.test(patchBlock));
  assert.ok(/MANUAL_BILLING_OVERRIDE_LINES[\s\S]*'pick_pack'/.test(route));
  assert.ok(/MANUAL_BILLING_OVERRIDE_LINES[\s\S]*'additional_unit'/.test(route));
  assert.ok(/MANUAL_BILLING_OVERRIDE_LINES[\s\S]*'shipping'/.test(route));
});

check('PS-392: Box Cost remains delegated to billing_box_resolutions', () => {
  assert.ok(/billingBoxResolutions/.test(patchBlock));
  assert.ok(/body\.packageCost/.test(patchBlock));
  assert.ok(!/lineType:\s*'package_cost'[\s\S]{0,300}upsertBillingManualOverride/.test(patchBlock));
});

check('PS-392: shipping override path does not mutate shipment selected-rate or label-cost truth', () => {
  assert.ok(!/\.update\(shipments\)/.test(patchBlock));
  assert.ok(!/selectedRateCost\s*:/.test(patchBlock));
  assert.ok(!/labelCost\s*:/.test(patchBlock));
  assert.ok(!/cost\s*:/.test(patchBlock));
});

check('PS-392: generator reads manual overrides and applies them before billing_line_items insert', () => {
  assert.ok(/readBillingManualOverrides\(orderIdsInScope\)/.test(billingService));
  assert.ok(/manualBillingOverrideByOrderId/.test(billingService));
  assert.ok(/applyManualBillingOverrides\(/.test(billingService));
  assert.ok(
    billingService.indexOf('applyManualBillingOverrides(') <
      billingService.indexOf('for (const row of effectiveRows)'),
    'manual overrides must apply before final generated rows are collected',
  );
});

check('PS-392: billing details DTO carries backend manual override markers', () => {
  assert.ok(/readBillingManualOverrides\(detailOrderIds\)/.test(billingService));
  assert.ok(/manualBillingOverrideLineTypes/.test(billingService));
  assert.ok(/manualBillingOverrideLabels/.test(billingService));
  assert.ok(/'manualBillingOverrideLineTypes'/.test(detailSot));
  assert.ok(/'manualBillingOverrideLabels'/.test(detailSot));
});

check('PS-392: admin UI renders backend manual override markers without owning money rules', () => {
  assert.ok(/manualBillingOverrideLineTypes/.test(detailTable));
  assert.ok(/Manual override/.test(detailTable));
  assert.ok(/Shipping override/.test(detailTable));
  assert.ok(/Manual override/.test(editModal));
});

check('PS-392: package exposes focused guard', () => {
  assert.equal(
    packageJson.scripts?.['test:ps-392-manual-billing-overrides'],
    'tsx scripts/ps-392-manual-billing-overrides-guard.ts',
  );
});

await check('PS-392: pure override applicator updates/inserts manual rows and clears shipping_missing', async () => {
  if (!existsSync(manualStorePath)) {
    throw new Error('manual override owner missing');
  }
  const mod = await import('../src/services/billing-manual-overrides.ts');
  const rows = [
    {
      clientId: 7,
      orderId: 101,
      orderNumber: 'A-101',
      shipmentId: 501,
      shipDate: new Date('2026-07-01T00:00:00Z'),
      lineType: 'shipping_missing',
      description: 'Missing shipping cost - reconcile',
      qty: '1',
      unitCost: '0.00',
      totalCost: '0.00',
      packageId: 9,
    },
    {
      clientId: 7,
      orderId: 101,
      orderNumber: 'A-101',
      shipmentId: 501,
      shipDate: new Date('2026-07-01T00:00:00Z'),
      lineType: 'package_cost',
      description: 'Box (8x6x4)',
      qty: '1',
      unitCost: '2.50',
      totalCost: '2.50',
      packageId: 9,
    },
  ];
  const out = mod.applyManualBillingOverrides(rows, [
    {
      orderId: 101,
      clientId: 7,
      lineType: 'shipping',
      amount: 12.34,
      reviewer: 'ops@example.com',
      reviewedAt: '2026-07-06T00:00:00Z',
      note: 'customer-billed shipping override',
    },
    {
      orderId: 101,
      clientId: 7,
      lineType: 'additional_unit',
      amount: 0,
      reviewer: 'ops@example.com',
      reviewedAt: '2026-07-06T00:00:00Z',
      note: 'manual addl units comp',
    },
  ], {
    clientId: 7,
    orderId: 101,
    orderNumber: 'A-101',
    shipmentId: 501,
    shipDate: new Date('2026-07-01T00:00:00Z'),
    packageId: 9,
  });

  assert.equal(out.some((row: { lineType: string }) => row.lineType === 'shipping_missing'), false);
  const shipping = out.find((row: { lineType: string }) => row.lineType === 'shipping');
  assert.equal(shipping?.totalCost, '12.34');
  const additional = out.find((row: { lineType: string }) => row.lineType === 'additional_unit');
  assert.equal(additional?.totalCost, '0.00');
  const box = out.find((row: { lineType: string }) => row.lineType === 'package_cost');
  assert.equal(box?.totalCost, '2.50');
});

if (failures > 0) {
  console.error(`\nFAIL PS-392 manual billing overrides guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-392 manual billing overrides guard');
