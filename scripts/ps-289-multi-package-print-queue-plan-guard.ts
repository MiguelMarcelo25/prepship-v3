/**
 * PS-289 - group-aware print queue planning guard.
 *
 * Proves multi-package labels can become print queue candidates without
 * touching the real print_queue_orders table or existing one-order-one-label
 * queue behavior.
 */
import { readFileSync } from 'node:fs';
import { buildMultiPackageShipmentPlan } from '../src/services/shipping-workflow/multi-package-shipment-plan';
import { buildMockedMultiPackageLabelFlow } from '../src/services/shipping-workflow/multi-package-mock-label-flow';
import {
  buildMultiPackagePrintQueuePlan,
} from '../src/services/shipping-workflow/multi-package-print-queue-plan';

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
  orderId: 28906,
  orderNumber: 'PS-289-PQ',
  packages: [
    {
      packageKey: 'left',
      weightOz: 8,
      dimensions: { length: 6, width: 4, height: 2 },
      items: [{ sku: 'LEFT-SKU', quantity: 2 }],
    },
    {
      packageKey: 'right',
      weightOz: 18,
      dimensions: { length: 10, width: 8, height: 4 },
      items: [{ sku: 'RIGHT-SKU', quantity: 1 }],
    },
  ],
});
const labelFlow = buildMockedMultiPackageLabelFlow(shipmentPlan, {
  clientId: 33,
  serviceLabel: 'MOCK GROUND',
});

const plan = buildMultiPackagePrintQueuePlan(labelFlow, { orderNumber: 'PS-289-PQ' });

check('print queue plan emits one candidate per package label',
  plan.entries.length === 2 && plan.group.packageCount === 2);
check('print queue plan keeps group identity and remains planned-only',
  plan.group.orderId === 28906 &&
    plan.group.clientId === 33 &&
    plan.group.groupKey === 'order:28906' &&
    plan.group.status === 'print_queue_planned');
check('queue ids are stable and package-aware',
  plan.entries[0]?.queueId === 'mpq:order:28906:package:left' &&
    plan.entries[1]?.queueId === 'mpq:order:28906:package:right');
check('entries carry label idempotency, label url, tracking, and package sequence',
  plan.entries[1]?.labelIdempotencyKey === 'order:28906:package:right' &&
    plan.entries[1]?.labelUrl === 'mock://multi-package/order%3A28906%3Apackage%3Aright' &&
    /^TESTMP\d{18}$/.test(plan.entries[1]?.trackingNumber ?? '') &&
    plan.entries[1]?.packageSequence === 2);
check('entries carry item summary without UI or queue-table dependency',
  plan.entries[0]?.primarySku === 'LEFT-SKU' &&
    plan.entries[0]?.orderQty === 2 &&
    plan.entries[0]?.skuGroupId === 'multi-package:left' &&
    plan.entries[0]?.itemDescription === 'LEFT-SKU x2');
check('entries are explicit non-live mocked queue candidates',
  plan.entries.every((entry) =>
    entry.status === 'planned' &&
    entry.provider === 'mock_multi_package' &&
    entry.isLivePostage === false &&
    entry.marketplaceConfirmationPlanned === false));

const repeat = buildMultiPackagePrintQueuePlan(labelFlow, { orderNumber: 'PS-289-PQ' });
check('print queue plan is deterministic for the same mocked labels',
  JSON.stringify(plan) === JSON.stringify(repeat));

let duplicateBlocked = false;
try {
  buildMultiPackagePrintQueuePlan(labelFlow, {
    existingQueuedLabelIdempotencyKeys: ['order:28906:package:right'],
  });
} catch (err) {
  duplicateBlocked = /already has a print queue candidate/.test(err instanceof Error ? err.message : String(err));
}
check('existing queued label idempotency blocks duplicate print candidates', duplicateBlocked);

const ownerSrc = readFileSync('src/services/shipping-workflow/multi-package-print-queue-plan.ts', 'utf8');
check('print queue plan owner exports buildMultiPackagePrintQueuePlan',
  /export function buildMultiPackagePrintQueuePlan/.test(ownerSrc));
check('print queue plan owner stays pure and does not import queue/db/provider modules',
  !/from ['"].*(db|schema|print-queue|connector|labels|shipstation|shipp|easypost|walmart|marketplace)/i.test(ownerSrc));
check('print queue plan owner documents no real queue writes',
  /No real print queue writes, provider calls, postage, marketplace, or shipped\/cancelled mutation/.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 print queue plan guard',
  packageJson.includes('"test:ps-289-multi-package-print-queue-plan"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package print queue plan guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package print queue plan guard');
