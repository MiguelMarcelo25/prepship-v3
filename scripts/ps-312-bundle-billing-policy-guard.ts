/**
 * PS-312/PS-317 (S5) — guard for the PURE bundle billing-treatment policy. Proves shipping/box is
 * billed ONCE on the primary: a non-bundled order and the primary bill normally; a child is
 * "Included — bundled with #<primary>" and its shipping/box are suppressed. Defensive: a
 * self-referential DTO can never suppress the order that IS the primary. No DB, no IO.
 */
import {
  decideBundleBillingTreatment,
  shouldSuppressShippingAndBox,
} from '../src/services/shipment-bundles/bundle-billing-policy';
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

const dto = (over: Partial<BundleRowDto>): BundleRowDto => ({
  bundleId: 9,
  role: 'child',
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

// Not bundled → bill normally, never suppressed.
check('a non-bundled order bills normally', decideBundleBillingTreatment(500, null).kind === 'bill-normally');
check('a non-bundled order is not suppressed', shouldSuppressShippingAndBox(500, null) === false);

// The primary bills normally (it carries the one real label) and is never suppressed.
check('the primary (100) bills normally', decideBundleBillingTreatment(100, dto({ role: 'primary' })).kind === 'bill-normally');
check('the primary is not suppressed', shouldSuppressShippingAndBox(100, dto({ role: 'primary' })) === false);

// A child is "Included — bundled with #<primary>" and its shipping/box are suppressed.
const childTreatment = decideBundleBillingTreatment(101, dto({ role: 'child' }));
check('a child is included-in-bundle, not billed separately', childTreatment.kind === 'included-in-bundle');
check('a child references the primary order # in the note',
  childTreatment.kind === 'included-in-bundle' &&
  childTreatment.primaryOrderId === 100 &&
  childTreatment.bundleId === 9 &&
  childTreatment.note === 'Included — bundled with #100');
check('a child has its shipping/box suppressed', shouldSuppressShippingAndBox(101, dto({ role: 'child' })) === true);

// Defensive: a self-referential DTO (role child but primaryOrderId === orderId) must NOT suppress
// the order that is actually the primary — bill-normally wins.
check('a self-referential DTO never suppresses the primary order',
  decideBundleBillingTreatment(100, dto({ role: 'child', primaryOrderId: 100 })).kind === 'bill-normally' &&
  shouldSuppressShippingAndBox(100, dto({ role: 'child', primaryOrderId: 100 })) === false);

if (failures > 0) {
  console.error(`\nPS-312 bundle billing-policy guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-312 bundle billing-policy guard passed.');
