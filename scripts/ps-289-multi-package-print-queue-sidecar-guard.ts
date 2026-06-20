/**
 * PS-289 - package-aware print queue sidecar guard.
 *
 * Proves purchased package labels can be persisted as print-queue candidates
 * in shipment group sidecars without touching the real print queue service/table.
 */
import { readFileSync } from 'node:fs';
import { purchaseMultiPackageLabels } from '../src/services/shipping-workflow/multi-package-label-purchase-boundary';
import {
  orchestrateMultiPackagePrintQueueSidecar,
  type MultiPackagePrintQueueSidecarEntry,
  type MultiPackagePrintQueueSidecarRepository,
} from '../src/services/shipping-workflow/multi-package-print-queue-sidecar';
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

const plan = buildMultiPackageShipmentPlan({
  orderId: 28911,
  orderNumber: 'PS-289-PQ-SIDECAR',
  packages: [
    {
      packageKey: 'first-box',
      weightOz: 18,
      dimensions: { length: 9, width: 7, height: 4 },
      items: [{ sku: 'FIRST-PQ', quantity: 2 }],
    },
    {
      packageKey: 'second-box',
      weightOz: 30,
      dimensions: { length: 15, width: 10, height: 5 },
      items: [{ sku: 'SECOND-PQ', quantity: 1 }],
    },
  ],
});

const purchaseFlow = await purchaseMultiPackageLabels(plan, {
  clientId: 91,
  serviceLabel: 'UPS Ground',
  purchaser: async (request) => ({
    labelIdempotencyKey: request.labelIdempotencyKey,
    shipmentId: 8100 + request.packageSequence,
    trackingNumber: `1ZPQ${request.packageSequence}`,
    labelUrl: `mock://print-queue-sidecar/${request.packageKey}`,
    provider: 'injected_test_purchaser',
    postageCost: request.packageSequence === 1 ? 5.2 : 7.8,
    isLivePostage: false,
  }),
});

const events: string[] = [];
let appliedGroupId = 0;
let appliedEntries: MultiPackagePrintQueueSidecarEntry[] = [];
let markedGroup: { groupId: number; packageCount: number; queueIds: string[] } | null = null;

const repository: MultiPackagePrintQueueSidecarRepository = {
  async findExistingQueuedLabelKeys(keys) {
    events.push(`find:${keys.join('|')}`);
    return [];
  },
  async applyPrintQueueCandidates(groupId, entries) {
    events.push(`apply:${groupId}:${entries.length}`);
    appliedGroupId = groupId;
    appliedEntries = entries;
  },
  async markGroupPrintQueuePlanned(groupId, packageCount, queueIds) {
    events.push(`mark:${groupId}:${packageCount}:${queueIds.join('|')}`);
    markedGroup = { groupId, packageCount, queueIds };
  },
};

const result = await orchestrateMultiPackagePrintQueueSidecar(601, purchaseFlow, { repository });

check('sidecar print queue orchestration emits one entry per purchased label',
  result.entries.length === 2 &&
    result.group.status === 'print_queue_sidecar_planned' &&
    result.group.packageCount === 2);
check('sidecar orchestration checks duplicates before applying queue candidates',
  events[0] === 'find:order:28911:package:first-box|order:28911:package:second-box' &&
    events[1] === 'apply:601:2');
check('queue entries are package-aware and deterministic',
  result.entries[0]?.queueId === 'mpq:order:28911:package:first-box' &&
    result.entries[1]?.queueId === 'mpq:order:28911:package:second-box' &&
    result.entries[1]?.packageSequence === 2);
check('queue entries carry purchased label facts',
  result.entries[1]?.shipmentId === 8102 &&
    result.entries[1]?.trackingNumber === '1ZPQ2' &&
    result.entries[1]?.labelUrl === 'mock://print-queue-sidecar/second-box' &&
    result.entries[1]?.provider === 'injected_test_purchaser');
check('queue entries carry item summary for printer display',
  result.entries[0]?.primarySku === 'FIRST-PQ' &&
    result.entries[0]?.orderQty === 2 &&
    result.entries[0]?.skuGroupId === 'multi-package:first-box' &&
    result.entries[0]?.itemDescription === 'FIRST-PQ x2');
check('queue entries stay sidecar planned and non-live',
  result.entries.every((entry) =>
    entry.status === 'print_queue_sidecar_planned' &&
    entry.realPrintQueueInserted === false &&
    entry.isLivePostage === false));
check('sidecar repository receives queue entries for the same group',
  appliedGroupId === 601 &&
    appliedEntries.length === 2 &&
    appliedEntries[1]?.labelIdempotencyKey === 'order:28911:package:second-box');
check('sidecar group is marked with all package queue IDs',
  markedGroup?.groupId === 601 &&
    markedGroup?.packageCount === 2 &&
    markedGroup?.queueIds.join('|') === result.entries.map((entry) => entry.queueId).join('|'));

let duplicateBlocked = false;
let duplicateEvents: string[] = [];
const duplicateRepository: MultiPackagePrintQueueSidecarRepository = {
  async findExistingQueuedLabelKeys(keys) {
    duplicateEvents.push(`find:${keys.length}`);
    return ['order:28911:package:second-box'];
  },
  async applyPrintQueueCandidates() {
    duplicateEvents.push('apply');
  },
  async markGroupPrintQueuePlanned() {
    duplicateEvents.push('mark');
  },
};
try {
  await orchestrateMultiPackagePrintQueueSidecar(601, purchaseFlow, {
    repository: duplicateRepository,
  });
} catch (err) {
  duplicateBlocked = /already has a print queue sidecar candidate/.test(
    err instanceof Error ? err.message : String(err),
  );
}
check('duplicate queued package label blocks before sidecar updates',
  duplicateBlocked && duplicateEvents.join('|') === 'find:2');

const ownerSrc = readFileSync('src/services/shipping-workflow/multi-package-print-queue-sidecar.ts', 'utf8');
check('print queue sidecar owner exports orchestrateMultiPackagePrintQueueSidecar',
  /export async function orchestrateMultiPackagePrintQueueSidecar/.test(ownerSrc));
check('print queue sidecar owner exports DB repository factory',
  /export function createDbMultiPackagePrintQueueSidecarRepository/.test(ownerSrc));
check('print queue sidecar owner writes only shipment group sidecars',
  ownerSrc.includes("from '../../db/schema/shipment-groups'") &&
    !/from ['"].*(routes|connector|shipstation|shipp|easypost|walmart|print-queue|marketplace|orders|shipments)/i.test(ownerSrc));
check('print queue sidecar owner documents no real print queue writes',
  /No real print queue table writes, printer calls, provider calls, marketplace API calls, or shipped\/cancelled mutation/.test(ownerSrc));

const packageJson = readFileSync('package.json', 'utf8');
check('package wires PS-289 print queue sidecar guard',
  packageJson.includes('"test:ps-289-multi-package-print-queue-sidecar"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package print queue sidecar guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package print queue sidecar guard');
