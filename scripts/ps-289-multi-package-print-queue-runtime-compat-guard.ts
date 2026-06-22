/**
 * PS-289 - offline print queue runtime compatibility guard.
 *
 * Proves package-scoped print queue ids can be mapped back to a numeric source
 * order id for future holds/recipient/dims/order-detail lookups before any real
 * print_queue_orders insert or printer path is enabled.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildMultiPackageRealPrintQueueDryRun,
} from '../src/services/shipping-workflow/multi-package-real-print-queue-contract';
import {
  buildPrintQueueRuntimeCompatPlan,
  parseMultiPackagePrintQueueOrderId,
  resolvePrintQueueSourceOrderId,
} from '../src/services/shipping-workflow/multi-package-print-queue-runtime-compat';
import {
  orchestrateMultiPackagePrintQueueSidecar,
  type MultiPackagePrintQueueSidecarEntry,
  type MultiPackagePrintQueueSidecarRepository,
} from '../src/services/shipping-workflow/multi-package-print-queue-sidecar';
import type { MultiPackageLabelPurchaseFlow } from '../src/services/shipping-workflow/multi-package-label-purchase-boundary';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function throws(name: string, fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
    check(name, false, 'expected throw');
  } catch (err) {
    check(name, pattern.test(err instanceof Error ? err.message : String(err)));
  }
}

function testFlow(): MultiPackageLabelPurchaseFlow {
  return {
    group: {
      orderId: 28901,
      clientId: 44,
      orderNumber: 'PS289-ORDER',
      groupKey: 'order:28901:multi-package',
      status: 'labels_purchased',
      packageCount: 2,
    },
    labels: [
      {
        orderId: 28901,
        clientId: 44,
        orderNumber: 'PS289-ORDER',
        shipmentGroupKey: 'order:28901:multi-package',
        packageKey: 'pkg-a',
        packageSequence: 1,
        labelIdempotencyKey: 'mp-label-28901-a',
        weightOz: 16,
        dimensions: { length: 8, width: 6, height: 4 },
        items: [{ sku: 'SKU-A', itemId: null, quantity: 1 }],
        serviceLabel: 'UPS Ground',
        shipmentId: 91001,
        trackingNumber: '1Z289A',
        labelUrl: '/labels/mock/91001',
        provider: 'shipstation',
        postageCost: 5.25,
        isLivePostage: false,
        status: 'purchased',
      },
      {
        orderId: 28901,
        clientId: 44,
        orderNumber: 'PS289-ORDER',
        shipmentGroupKey: 'order:28901:multi-package',
        packageKey: 'pkg-b',
        packageSequence: 2,
        labelIdempotencyKey: 'mp-label-28901-b',
        weightOz: 24,
        dimensions: { length: 10, width: 7, height: 5 },
        items: [{ sku: 'SKU-B', itemId: null, quantity: 2 }],
        serviceLabel: 'UPS Ground',
        shipmentId: 91002,
        trackingNumber: '1Z289B',
        labelUrl: '/labels/mock/91002',
        provider: 'shipstation',
        postageCost: 6.75,
        isLivePostage: false,
        status: 'purchased',
      },
    ],
    totalPostageCost: 12,
  };
}

const packageJson = read('package.json');
const statusDoc = read('docs/ps-tickets/ps-289-multi-package-status.md');
const normalizedStatusDoc = statusDoc.replace(/\s+/g, ' ');
const closeoutGuard = read('scripts/ps-289-multi-package-closeout-guard.ts');
const compatSrc = read('src/services/shipping-workflow/multi-package-print-queue-runtime-compat.ts');
const printQueueService = read('src/services/print-queue.ts');

const applied: MultiPackagePrintQueueSidecarEntry[][] = [];
const repo: MultiPackagePrintQueueSidecarRepository = {
  async findExistingQueuedLabelKeys() {
    return [];
  },
  async applyPrintQueueCandidates(_groupId, entries) {
    applied.push(entries);
  },
  async markGroupPrintQueuePlanned() {
    // dry-run repository only
  },
};

const sidecarPlan = await orchestrateMultiPackagePrintQueueSidecar(77, testFlow(), { repository: repo });
const dryRun = buildMultiPackageRealPrintQueueDryRun(sidecarPlan);
const compatPlan = buildPrintQueueRuntimeCompatPlan(dryRun.entries);

check('fixture produces two package-scoped dry-run entries',
  dryRun.entries.length === 2 && applied[0]?.length === 2);
check('parser extracts source order, package sequence, and package key',
  JSON.stringify(parseMultiPackagePrintQueueOrderId('mp:28901:2:pkg-b')) ===
    JSON.stringify({ sourceOrderId: 28901, packageSequence: 2, packageKey: 'pkg-b' }));
check('source-order resolver keeps normal numeric order ids working',
  resolvePrintQueueSourceOrderId('28901') === 28901 && resolvePrintQueueSourceOrderId(28901) === 28901);
check('source-order resolver maps package-scoped ids back to the numeric source order',
  dryRun.entries.every((entry) => resolvePrintQueueSourceOrderId(entry.orderId) === entry.sourceOrderId));
check('compat plan keeps one runtime entry per package and one source order lookup id',
  compatPlan.entries.length === 2 &&
    compatPlan.sourceOrderIds.length === 1 &&
    compatPlan.sourceOrderIds[0] === 28901);
check('compat entries preserve package identity for future package-aware rendering',
  compatPlan.entries.every((entry) =>
    entry.isMultiPackage &&
    entry.sourceOrderId === 28901 &&
    entry.packageSequence != null &&
    entry.packageKey?.startsWith('pkg-')));
check('compat plan is safe for numeric source-order lookups',
  compatPlan.hasMultiPackageEntries && compatPlan.compatibleWithNumericSourceOrderLookups);

throws('compat plan rejects invalid non-numeric order ids',
  () => buildPrintQueueRuntimeCompatPlan([{ id: 'bad', clientId: 44, orderId: 'not-a-source-order' }]),
  /does not resolve to a numeric source order id/);
throws('parser rejects malformed package-scoped ids',
  () => {
    const parsed = parseMultiPackagePrintQueueOrderId('mp:28901:0:pkg-a');
    if (parsed == null) throw new Error('malformed rejected');
  },
  /malformed rejected/);

check('current print queue runtime still has numeric orderId assumptions the compat owner must replace',
  printQueueService.includes('entries.map((e) => Number(e.orderId))') &&
    printQueueService.includes('holds.has(Number(e.orderId))') &&
    printQueueService.includes('const numericOrderId = Number(input.orderId)'));
check('compat helper stays pure and offline',
  /Pure only/.test(compatSrc) &&
    !/from ['"].*(db|schema|routes|connectors|marketplace|shipstation|shipp|easypost|walmart|print-queue)/i.test(compatSrc) &&
    !/\.insert\(|\.update\(|\.delete\(|fetch\(/.test(compatSrc));
check('package wires PS-289 print queue runtime compat guard',
  /"test:ps-289-multi-package-print-queue-runtime-compat"\s*:\s*"tsx scripts\/ps-289-multi-package-print-queue-runtime-compat-guard\.ts"/.test(packageJson));
check('status doc lists runtime compatibility guard and still blocks real queue insertion',
  statusDoc.includes('`test:ps-289-multi-package-print-queue-runtime-compat`') &&
    /runtime compatibility proof maps package-scoped queue ids back to numeric source order ids/i.test(normalizedStatusDoc) &&
    /no real queue insert is enabled yet/i.test(normalizedStatusDoc));
check('closeout guard includes runtime compatibility proof',
  closeoutGuard.includes('multi-package-print-queue-runtime-compat.ts') &&
    closeoutGuard.includes('test:ps-289-multi-package-print-queue-runtime-compat'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package print queue runtime compatibility guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package print queue runtime compatibility guard');
