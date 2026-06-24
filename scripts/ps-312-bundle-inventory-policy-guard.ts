/**
 * PS-312/PS-317 (S6) — guard for the PURE bundle inventory-deduction policy. Proves: a draft bundle
 * deducts NOTHING; a labeled bundle deducts every member once (children included, fixing the
 * under-deduction a one-label bundle would otherwise cause); an already-deducted member is skipped
 * (idempotent — never double-deduct). No DB, no IO.
 */
import { planBundleInventoryDeduction } from '../src/services/shipment-bundles/bundle-inventory-policy';
import type { BundleRowDto } from '../src/services/shipment-bundles/bundle-read-model';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const bundle = (over: Partial<BundleRowDto>): BundleRowDto => ({
  bundleId: 9,
  role: 'primary',
  status: 'labeled',
  primaryOrderId: 100,
  memberOrderIds: [100, 101, 102],
  memberCount: 3,
  trackingNumber: '1ZSHARED',
  carrierCode: 'ups',
  serviceCode: 'ground',
  labelUrl: 'https://x/l.pdf',
  labelShipmentId: null,
  packageId: 42,
  primaryShipmentId: 9001,
  ...over,
});

// A draft (unlabeled) bundle deducts nothing.
const draftPlan = planBundleInventoryDeduction(bundle({ status: 'draft' }));
check('a draft bundle deducts NOTHING (waits for the label)',
  draftPlan.orderIdsToDeduct.length === 0 && draftPlan.reason === 'bundle-not-labeled');

// A labeled bundle, nothing deducted yet → deduct EVERY member once (children included).
const fullPlan = planBundleInventoryDeduction(bundle({ status: 'labeled' }));
check('a labeled bundle deducts every member once (primary + both children)',
  JSON.stringify(fullPlan.orderIdsToDeduct) === JSON.stringify([100, 101, 102]) &&
  fullPlan.skippedAlreadyDeducted.length === 0 && fullPlan.reason === null);

// Idempotency: the primary already deducted → only the children remain.
const partialPlan = planBundleInventoryDeduction(bundle({ status: 'labeled' }), [100]);
check('an already-deducted member is skipped (only children remain)',
  JSON.stringify(partialPlan.orderIdsToDeduct) === JSON.stringify([101, 102]) &&
  JSON.stringify(partialPlan.skippedAlreadyDeducted) === JSON.stringify([100]));

// Idempotency: all already deducted → nothing more (never double-deduct).
const donePlan = planBundleInventoryDeduction(bundle({ status: 'labeled' }), [100, 101, 102]);
check('a fully-deducted bundle deducts nothing more (never double-deduct)',
  donePlan.orderIdsToDeduct.length === 0 &&
  JSON.stringify(donePlan.skippedAlreadyDeducted) === JSON.stringify([100, 101, 102]));

if (failures > 0) {
  console.error(`\nPS-312 bundle inventory-policy guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-312 bundle inventory-policy guard passed.');
