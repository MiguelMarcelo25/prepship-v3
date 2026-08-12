/**
 * PS-375 — a manual Edit Billing Detail save of Box Cost $0.00 resolves the row
 * (clears NEEDS REVIEW / No box cost), immediately and across regeneration.
 *
 * Bug: PATCH /billing/details/:orderId deleted the package_cost_missing review
 * line on a $0 save but never inserted a $0 package_cost line (the insert was
 * gated `value > 0`), so the refreshed row had hasPackageCostLine=false and the
 * missing-cost alert re-fired. Fix: a deliberate box-cost save emits an explicit
 * $0 package_cost line, so the row reads resolved-zero (same shape PS-374 uses).
 *
 * Offline (no db):
 *   Layer 1 — route source pins: the $0 package_cost insert, the missing-line
 *             delete, and the $0 override-resolution write (durable across regen).
 *   Layer 2 — the grouped DTO the FE + Invoice consume: an explicit $0 package_cost
 *             line reads resolved; the pre-fix state (missing line gone, no $0 line)
 *             would still alert.
 *   Layer 3 — regen durability via PS-374's decidePackageCostLine; FE save refresh.
 *
 *   npx tsx scripts/ps-375-manual-zero-box-cost-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveBillingBoxCostAlert, NO_BOX_COST_BILLING_BADGE } from '../src/services/billing-box-cost-alert';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';

let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`ok   ${name}`); }
  catch (err) { failures += 1; console.error(`FAIL ${name} — ${err instanceof Error ? err.message : err}`); }
}
const read = (p: string) => readFileSync(p, 'utf8');

// ── Layer 1: the PATCH /billing/details/:orderId route ───────────────────────
const route = read('src/routes/billing.ts');

check('PATCH inserts an explicit $0 package_cost line on a deliberate box-cost save', () => {
  assert.ok(/rows\.length === 0 && \(value > 0 \|\| lineType === 'package_cost'\)/.test(route),
    'the insert guard must allow a $0 package_cost line (fee lines still require value > 0)');
});

check('PATCH still deletes the package_cost_missing review line on resolution', () => {
  assert.ok(/\.delete\(billingLineItems\)[\s\S]*lineType, 'package_cost_missing'\)/.test(route));
});

check('PATCH persists the operator resolution (overridePrice) for a $0 price change', () => {
  // A $0 over an absent/null current box line IS a price change → the resolution
  // stores overridePrice = the submitted $0, so regeneration keeps it resolved.
  assert.ok(/body\.packageCost !== undefined && money\(body\.packageCost\) !== currentBoxAmount/.test(route));
  // PS-499 put a bulk-import branch in front of this expression: a pasted box is
  // never a price decision, so it always clears the pin. The MANUAL path this
  // guard protects is unchanged — for a manual edit `bulkBoxIntent` is false and
  // the expression reduces to exactly the original one, pinned below.
  assert.ok(/overridePrice = bulkBoxIntent\s*\n?\s*\? null/.test(route),
    'a bulk import must never pin a price');
  assert.ok(/priceChanged && !isAutofillOfConfigured\s*\n?\s*\? submittedAmount/.test(route),
    'a manual $0 price change must still persist submittedAmount as the override');
});

// ── Layer 2: the grouped DTO reads resolved (the FE + Invoice consume it) ─────
check('DTO: an explicit $0 package_cost line reads resolved (no NO_BOX_COST, no review)', () => {
  const [dto] = toBillingDetailOrderRows([
    { orderId: 1, lineType: 'pick_pack', totalCost: '2.00', clientHasBoxPricing: true },
    { orderId: 1, lineType: 'package_cost', totalCost: '0.00', packageId: 7, clientHasBoxPricing: true },
  ]);
  assert.equal(dto.hasPackageCostLine, true);
  assert.equal(dto.packageTotal, 0);
  assert.equal(dto.boxCostAlert, false);
  assert.ok(!dto.billingBadges.includes(NO_BOX_COST_BILLING_BADGE));
  assert.equal(dto.packageCostNeedsReview === true, false);
});

check('DTO: the pre-fix state (missing line deleted, NO $0 line) would STILL alert', () => {
  const [dto] = toBillingDetailOrderRows([
    { orderId: 2, lineType: 'pick_pack', totalCost: '2.00', clientHasBoxPricing: true },
  ]);
  assert.equal(dto.hasPackageCostLine, false);
  assert.equal(dto.boxCostAlert, true, 'box pricing + no box line → the missing-cost alert (the PS-375 bug the $0 line fixes)');
});

check('alert primitive: $0 package_cost line resolved; a missing line alerts', () => {
  assert.equal(resolveBillingBoxCostAlert({ packageCost: 0, hasPackageCostLine: true, canAlertMissing: true, clientHasBoxPricing: true }).boxCostAlert, false);
  assert.equal(resolveBillingBoxCostAlert({ packageCost: null, hasPackageCostLine: false, canAlertMissing: true, clientHasBoxPricing: true }).boxCostAlert, true);
});

// ── Layer 3: regen durability + FE refresh ───────────────────────────────────
check('regen durability: decidePackageCostLine emits a $0 line for an override of 0 (PS-374)', () => {
  const policy = read('src/services/billing-box-policy.ts');
  assert.ok(/if \(r\.overridePrice != null\) \{[\s\S]*kind: 'line'/.test(policy));
});

check('FE: the edit save refreshes /billing/details and closes the modal (no stale panel)', () => {
  const view = read('web/src/components/Views/BillingView.tsx');
  assert.ok(/updateBillingDetail\(orderId, detailState\.clientId/.test(view));
  assert.ok(/fetchBillingDetails\(from, to, detailState\.clientId\)/.test(view));
  assert.ok(/setBillingEditModal\(null\)/.test(view));
});

if (failures > 0) {
  console.error(`\nPS-375 manual zero box-cost guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-375 manual zero box-cost guard passed.');
