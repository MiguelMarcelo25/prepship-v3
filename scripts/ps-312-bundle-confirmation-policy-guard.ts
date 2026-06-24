/**
 * PS-312/PS-317 (S7) — guard for the PURE bundle confirmation policy. Proves: a draft bundle (or one
 * with no shared tracking) confirms NOTHING; a labeled bundle with shared tracking confirms every
 * member once, EACH carrying the SAME shared tracking/carrier (so children show as shipped, not "no
 * tracking"); an already-confirmed member is skipped (idempotent — never double-confirm). No DB, no IO.
 */
import { planBundleShipmentConfirmations } from '../src/services/shipment-bundles/bundle-confirmation-policy';
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

// A draft bundle confirms nothing.
const draftPlan = planBundleShipmentConfirmations(bundle({ status: 'draft' }));
check('a draft bundle confirms NOTHING (waits for the label)',
  draftPlan.intents.length === 0 && draftPlan.reason === 'bundle-not-labeled');

// A labeled bundle without a shared tracking confirms nothing (defensive).
const noTrackPlan = planBundleShipmentConfirmations(bundle({ status: 'labeled', trackingNumber: null }));
check('a labeled bundle with no shared tracking confirms NOTHING',
  noTrackPlan.intents.length === 0 && noTrackPlan.reason === 'no-shared-tracking');

// A labeled bundle with tracking → confirm every member once, each with the SAME shared tracking.
const fullPlan = planBundleShipmentConfirmations(bundle({ status: 'labeled' }));
check('a labeled bundle confirms every member once (primary + both children)',
  JSON.stringify(fullPlan.intents.map((i) => i.orderId)) === JSON.stringify([100, 101, 102]) &&
  fullPlan.reason === null);
check('EVERY member confirmation carries the SAME shared tracking + carrier',
  fullPlan.intents.every((i) => i.trackingNumber === '1ZSHARED' && i.carrierCode === 'ups'));

// Idempotency: one already confirmed → only the rest remain.
const partialPlan = planBundleShipmentConfirmations(bundle({ status: 'labeled' }), [100]);
check('an already-confirmed member is skipped (only the rest remain)',
  JSON.stringify(partialPlan.intents.map((i) => i.orderId)) === JSON.stringify([101, 102]) &&
  JSON.stringify(partialPlan.skippedAlreadyConfirmed) === JSON.stringify([100]));

// Idempotency: all confirmed → nothing more (never double-confirm a marketplace).
const donePlan = planBundleShipmentConfirmations(bundle({ status: 'labeled' }), [100, 101, 102]);
check('a fully-confirmed bundle confirms nothing more (never double-confirm)',
  donePlan.intents.length === 0 &&
  JSON.stringify(donePlan.skippedAlreadyConfirmed) === JSON.stringify([100, 101, 102]));

if (failures > 0) {
  console.error(`\nPS-312 bundle confirmation-policy guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-312 bundle confirmation-policy guard passed.');
