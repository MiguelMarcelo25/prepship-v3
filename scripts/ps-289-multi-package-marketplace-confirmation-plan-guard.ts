/**
 * PS-289 - multi-package marketplace confirmation planning guard.
 *
 * Proves a package group can prepare one marketplace confirmation candidate
 * per package tracking number without calling a marketplace API or mutating
 * shipped/cancelled data.
 */
import { readFileSync } from 'node:fs';
import { buildMockedMultiPackageLabelFlow } from '../src/services/shipping-workflow/multi-package-mock-label-flow';
import {
  buildMultiPackageMarketplaceConfirmationPlan,
} from '../src/services/shipping-workflow/multi-package-marketplace-confirmation-plan';
import { buildMultiPackageShipmentPlan } from '../src/services/shipping-workflow/multi-package-shipment-plan';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : ` - ${String(detail)}`}`);
}

const shipmentPlan = buildMultiPackageShipmentPlan({
  orderId: 28907,
  orderNumber: 'PS-289-MKT',
  packages: [
    {
      packageKey: 'book-box',
      weightOz: 16,
      dimensions: { length: 8, width: 6, height: 3 },
      items: [{ sku: 'BOOK-SKU', quantity: 1 }],
    },
    {
      packageKey: 'poster-tube',
      weightOz: 11,
      dimensions: { length: 18, width: 3, height: 3 },
      items: [{ sku: 'POSTER-SKU', quantity: 2 }],
    },
    {
      packageKey: 'bonus-pack',
      weightOz: 5,
      dimensions: { length: 5, width: 4, height: 2 },
      items: [{ sku: 'BONUS-SKU', quantity: 1 }],
    },
  ],
});

const labelFlow = buildMockedMultiPackageLabelFlow(shipmentPlan, {
  clientId: 55,
  serviceLabel: 'MOCK GROUND',
});

const plan = buildMultiPackageMarketplaceConfirmationPlan(labelFlow, {
  carrierName: 'Mock Carrier',
  orderNumber: 'PS-289-MKT',
});

check('marketplace plan emits one confirmation candidate per package label',
  plan.confirmations.length === 3 && plan.group.packageCount === 3);
check('marketplace plan keeps group identity and remains planned-only',
  plan.group.orderId === 28907 &&
    plan.group.clientId === 55 &&
    plan.group.groupKey === 'order:28907' &&
    plan.group.status === 'marketplace_confirmation_planned');
check('tracking numbers preserve package order and include all packages',
  plan.trackingNumbers.length === 3 &&
    plan.trackingNumbers.join('|') === labelFlow.labels.map((label) => label.trackingNumber).join('|'));
check('confirmation ids are stable and package-aware',
  plan.confirmations[0]?.confirmationId === 'mpc:order:28907:package:book-box' &&
    plan.confirmations[1]?.confirmationId === 'mpc:order:28907:package:poster-tube' &&
    plan.confirmations[2]?.confirmationId === 'mpc:order:28907:package:bonus-pack');
check('confirmation entries carry label identity and package sequence',
  plan.confirmations[1]?.labelIdempotencyKey === 'order:28907:package:poster-tube' &&
    plan.confirmations[1]?.packageKey === 'poster-tube' &&
    plan.confirmations[1]?.packageSequence === 2 &&
    plan.confirmations[1]?.shipmentId === labelFlow.labels[1]?.shipmentId);
check('confirmation entries carry tracking, carrier, service, and order number',
  plan.confirmations[2]?.trackingNumber === labelFlow.labels[2]?.trackingNumber &&
    plan.confirmations[2]?.carrierName === 'Mock Carrier' &&
    plan.confirmations[2]?.serviceLabel === 'MOCK GROUND' &&
    plan.confirmations[2]?.orderNumber === 'PS-289-MKT');
check('confirmation candidates are explicit non-live mocked marketplace plans',
  plan.confirmations.every((entry) =>
    entry.status === 'planned' &&
    entry.provider === 'mock_multi_package' &&
    entry.isLiveNotification === false &&
    entry.marketplaceConfirmationPlanned === true));

const repeat = buildMultiPackageMarketplaceConfirmationPlan(labelFlow, {
  carrierName: 'Mock Carrier',
  orderNumber: 'PS-289-MKT',
});
check('marketplace confirmation plan is deterministic for the same mocked labels',
  JSON.stringify(plan) === JSON.stringify(repeat));

let duplicateBlocked = false;
try {
  buildMultiPackageMarketplaceConfirmationPlan(labelFlow, {
    existingConfirmationLabelIdempotencyKeys: ['order:28907:package:poster-tube'],
  });
} catch (err) {
  duplicateBlocked = /already has a marketplace confirmation candidate/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('existing confirmation label idempotency blocks duplicate confirmation candidates', duplicateBlocked);

const ownerSrc = readFileSync(
  'src/services/shipping-workflow/multi-package-marketplace-confirmation-plan.ts',
  'utf8',
);
check('marketplace confirmation owner exports buildMultiPackageMarketplaceConfirmationPlan',
  /export function buildMultiPackageMarketplaceConfirmationPlan/.test(ownerSrc));
check('marketplace confirmation owner stays pure and does not import marketplace/db/provider modules',
  !/from ['"].*(db|schema|print-queue|connector|labels|shipstation|shipp|easypost|walmart|marketplace)/i.test(ownerSrc));
check('marketplace confirmation owner documents no marketplace API calls',
  /No marketplace API calls, live notifications, provider calls, postage, print queue writes, or shipped\/cancelled mutation/.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 marketplace confirmation plan guard',
  packageJson.includes('"test:ps-289-multi-package-marketplace-confirmation-plan"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package marketplace confirmation plan guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package marketplace confirmation plan guard');
