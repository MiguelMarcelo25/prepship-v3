/**
 * PS-289 - mocked per-package label workflow guard.
 *
 * This proves the next backend-owned workflow slice without DB writes,
 * provider calls, postage, print queue mutation, marketplace confirmation, or
 * shipped/cancelled mutation.
 */
import { readFileSync } from 'node:fs';
import { buildMultiPackageShipmentPlan } from '../src/services/shipping-workflow/multi-package-shipment-plan';
import {
  buildMockedMultiPackageLabelFlow,
} from '../src/services/shipping-workflow/multi-package-mock-label-flow';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : ` - ${String(detail)}`}`);
}

const plan = buildMultiPackageShipmentPlan({
  orderId: 28904,
  orderNumber: 'PS-289-MOCK',
  packages: [
    {
      packageKey: 'front-box',
      weightOz: 12,
      dimensions: { length: 9, width: 6, height: 3 },
      items: [{ sku: 'A', quantity: 1 }],
    },
    {
      packageKey: 'back-box',
      weightOz: 28,
      dimensions: { length: 12, width: 8, height: 4 },
      items: [{ sku: 'B', quantity: 2 }],
    },
  ],
});

const flow = buildMockedMultiPackageLabelFlow(plan, {
  clientId: 44,
  serviceLabel: 'TEST GROUND',
});

check('mocked flow emits one package label per planned package',
  flow.labels.length === 2 && flow.group.packageCount === 2);
check('mocked flow keeps group-level identity from the planner',
  flow.group.orderId === 28904 &&
    flow.group.clientId === 44 &&
    flow.group.groupKey === 'order:28904' &&
    flow.group.status === 'mock_labels_created');
check('each mocked label keeps the package idempotency key',
  flow.labels[0]?.labelIdempotencyKey === 'order:28904:package:front-box' &&
    flow.labels[1]?.labelIdempotencyKey === 'order:28904:package:back-box');
check('each mocked label gets deterministic fake shipment/tracking/label url',
  flow.labels[0]?.shipmentId !== flow.labels[1]?.shipmentId &&
    flow.labels[0]?.shipmentId < 0 &&
    /^TESTMP\d{18}$/.test(flow.labels[0]?.trackingNumber ?? '') &&
    flow.labels[0]?.labelUrl === 'mock://multi-package/order%3A28904%3Apackage%3Afront-box');
check('mocked labels are explicit zero-postage non-live labels',
  flow.labels.every((label) =>
    label.provider === 'mock_multi_package' &&
    label.postageCost === 0 &&
    label.isLivePostage === false &&
    label.marketplaceConfirmationPlanned === false));
check('mocked labels preserve package dims and item quantities',
  flow.labels[1]?.weightOz === 28 &&
    flow.labels[1]?.dimensions.height === 4 &&
    flow.labels[1]?.items[0]?.sku === 'B' &&
    flow.labels[1]?.items[0]?.quantity === 2);

const repeat = buildMockedMultiPackageLabelFlow(plan, { clientId: 44, serviceLabel: 'TEST GROUND' });
check('mocked flow is deterministic for the same plan',
  JSON.stringify(flow) === JSON.stringify(repeat));

let duplicateBlocked = false;
try {
  buildMockedMultiPackageLabelFlow(plan, {
    existingLabelIdempotencyKeys: ['order:28904:package:back-box'],
  });
} catch (err) {
  duplicateBlocked = /already has a mocked label/.test(err instanceof Error ? err.message : String(err));
}
check('existing package label idempotency blocks duplicate labels', duplicateBlocked);

const ownerSrc = readFileSync('src/services/shipping-workflow/multi-package-mock-label-flow.ts', 'utf8');
check('mock label owner exports buildMockedMultiPackageLabelFlow',
  /export function buildMockedMultiPackageLabelFlow/.test(ownerSrc));
check('mock label owner has no DB/provider/queue/marketplace imports',
  !/from ['"].*(db|schema|connector|labels|print-queue|shipstation|shipp|easypost|walmart|marketplace)/i.test(ownerSrc));
check('mock label owner documents no live postage or mutation behavior',
  /No provider calls, postage, print queue, marketplace, or shipped\/cancelled mutation/.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 mocked label flow guard',
  packageJson.includes('"test:ps-289-multi-package-mock-label-flow"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 mocked multi-package label flow guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 mocked multi-package label flow guard');
