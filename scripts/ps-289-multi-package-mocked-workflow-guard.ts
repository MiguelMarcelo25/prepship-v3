/**
 * PS-289 - end-to-end mocked multi-package workflow guard.
 *
 * Proves the pure workflow owner carries package identity through planning,
 * mocked labels, print queue candidates, and marketplace confirmation candidates.
 */
import { readFileSync } from 'node:fs';
import {
  buildMockedMultiPackageWorkflow,
} from '../src/services/shipping-workflow/multi-package-mocked-workflow';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : ` - ${String(detail)}`}`);
}

const workflow = buildMockedMultiPackageWorkflow({
  orderId: 28908,
  orderNumber: 'PS-289-E2E',
  packages: [
    {
      packageKey: 'alpha',
      weightOz: 12,
      dimensions: { length: 8, width: 5, height: 3 },
      items: [{ sku: 'ALPHA-SKU', quantity: 1 }],
    },
    {
      packageKey: 'beta',
      weightOz: 20,
      dimensions: { length: 12, width: 9, height: 4 },
      items: [{ sku: 'BETA-SKU', quantity: 2 }],
    },
    {
      packageKey: 'gamma',
      weightOz: 7,
      dimensions: { length: 5, width: 4, height: 2 },
      items: [{ sku: 'GAMMA-SKU', quantity: 1 }],
    },
  ],
}, {
  clientId: 66,
  carrierName: 'Mock Carrier',
  serviceLabel: 'MOCK GROUND',
});

check('workflow summary marks the full mocked chain as planned',
  workflow.summary.status === 'mocked_workflow_planned' &&
    workflow.summary.orderId === 28908 &&
    workflow.summary.clientId === 66 &&
    workflow.summary.groupKey === 'order:28908' &&
    workflow.summary.packageCount === 3);
check('workflow keeps one object per package in every stage',
  workflow.shipmentPlan.packages.length === 3 &&
    workflow.labelFlow.labels.length === 3 &&
    workflow.printQueuePlan.entries.length === 3 &&
    workflow.marketplaceConfirmationPlan.confirmations.length === 3);
check('workflow preserves package idempotency from plan through mocked labels',
  workflow.shipmentPlan.packages.every((pkg, index) =>
    workflow.labelFlow.labels[index]?.labelIdempotencyKey === pkg.labelIdempotencyKey &&
    workflow.labelFlow.labels[index]?.packageKey === pkg.packageKey));
check('workflow print queue entries are aligned to mocked labels',
  workflow.printQueuePlan.entries.every((entry, index) =>
    entry.labelIdempotencyKey === workflow.labelFlow.labels[index]?.labelIdempotencyKey &&
    entry.trackingNumber === workflow.labelFlow.labels[index]?.trackingNumber &&
    entry.packageSequence === workflow.labelFlow.labels[index]?.packageSequence));
check('workflow marketplace confirmations are aligned to mocked labels',
  workflow.marketplaceConfirmationPlan.confirmations.every((entry, index) =>
    entry.labelIdempotencyKey === workflow.labelFlow.labels[index]?.labelIdempotencyKey &&
    entry.trackingNumber === workflow.labelFlow.labels[index]?.trackingNumber &&
    entry.shipmentId === workflow.labelFlow.labels[index]?.shipmentId));
check('workflow exposes all package tracking numbers in package order',
  workflow.summary.trackingNumbers.join('|') === workflow.labelFlow.labels.map((label) => label.trackingNumber).join('|') &&
    workflow.summary.trackingNumbers.join('|') === workflow.marketplaceConfirmationPlan.trackingNumbers.join('|'));
check('workflow is explicit non-live proof only',
  workflow.summary.isLivePostage === false &&
    workflow.summary.isLiveMarketplaceNotification === false &&
    workflow.labelFlow.labels.every((label) => label.isLivePostage === false && label.postageCost === 0) &&
    workflow.printQueuePlan.entries.every((entry) => entry.isLivePostage === false) &&
    workflow.marketplaceConfirmationPlan.confirmations.every((entry) => entry.isLiveNotification === false));

const repeat = buildMockedMultiPackageWorkflow({
  orderId: 28908,
  orderNumber: 'PS-289-E2E',
  packages: [
    { packageKey: 'alpha', weightOz: 12, items: [{ sku: 'ALPHA-SKU', quantity: 1 }] },
    { packageKey: 'beta', weightOz: 20, items: [{ sku: 'BETA-SKU', quantity: 2 }] },
    { packageKey: 'gamma', weightOz: 7, items: [{ sku: 'GAMMA-SKU', quantity: 1 }] },
  ],
}, {
  clientId: 66,
  carrierName: 'Mock Carrier',
  serviceLabel: 'MOCK GROUND',
});
check('workflow is deterministic for the same package plan',
  workflow.summary.trackingNumbers.join('|') === repeat.summary.trackingNumbers.join('|') &&
    workflow.printQueuePlan.entries.map((entry) => entry.queueId).join('|') ===
      repeat.printQueuePlan.entries.map((entry) => entry.queueId).join('|'));

let duplicateLabelBlocked = false;
try {
  buildMockedMultiPackageWorkflow({
    orderId: 28908,
    packages: [{ packageKey: 'alpha' }],
  }, {
    existingLabelIdempotencyKeys: ['order:28908:package:alpha'],
  });
} catch (err) {
  duplicateLabelBlocked = /already has a mocked label/.test(err instanceof Error ? err.message : String(err));
}
check('workflow blocks duplicate package labels before downstream planning', duplicateLabelBlocked);

let duplicateQueueBlocked = false;
try {
  buildMockedMultiPackageWorkflow({
    orderId: 28908,
    packages: [{ packageKey: 'alpha' }],
  }, {
    existingQueuedLabelIdempotencyKeys: ['order:28908:package:alpha'],
  });
} catch (err) {
  duplicateQueueBlocked = /already has a print queue candidate/.test(err instanceof Error ? err.message : String(err));
}
check('workflow blocks duplicate print queue candidates', duplicateQueueBlocked);

let duplicateConfirmationBlocked = false;
try {
  buildMockedMultiPackageWorkflow({
    orderId: 28908,
    packages: [{ packageKey: 'alpha' }],
  }, {
    existingConfirmationLabelIdempotencyKeys: ['order:28908:package:alpha'],
  });
} catch (err) {
  duplicateConfirmationBlocked = /already has a marketplace confirmation candidate/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('workflow blocks duplicate marketplace confirmation candidates', duplicateConfirmationBlocked);

const ownerSrc = readFileSync('src/services/shipping-workflow/multi-package-mocked-workflow.ts', 'utf8');
check('mocked workflow owner exports buildMockedMultiPackageWorkflow',
  /export function buildMockedMultiPackageWorkflow/.test(ownerSrc));
check('mocked workflow owner documents no live side effects',
  /No DB writes, provider calls, real labels, postage, print queue writes, marketplace API calls, or shipped\/cancelled mutation/.test(ownerSrc));
check('mocked workflow owner imports only PS-289 pure planning modules',
  !/from ['"].*(db|schema|routes|connector|shipstation|shipp|easypost|walmart|orders|shipments)/i.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 mocked workflow guard',
  packageJson.includes('"test:ps-289-multi-package-mocked-workflow"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 mocked multi-package workflow guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 mocked multi-package workflow guard');
