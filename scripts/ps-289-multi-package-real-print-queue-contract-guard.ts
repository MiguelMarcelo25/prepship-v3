/**
 * PS-289 - dry-run real print queue contract guard.
 *
 * Offline only. This proves multi-package sidecar labels can be translated into
 * package-scoped real print_queue_orders insert shapes without collapsing under
 * the current unique(order_id, client_id) constraint. It performs no DB writes,
 * no printer calls, no label purchase, no marketplace notification, and no
 * shipped/cancelled mutation.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildMultiPackageRealPrintQueueDryRun,
  multiPackagePrintQueueOrderId,
  printQueueOrderClientKey,
} from '../src/services/shipping-workflow/multi-package-real-print-queue-contract';
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

function hasScript(packageJson: string, script: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${script}"\\s*:\\s*"${escaped}"`).test(packageJson);
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
const contractSrc = read('src/services/shipping-workflow/multi-package-real-print-queue-contract.ts');
const statusDoc = read('docs/ps-tickets/ps-289-multi-package-status.md');
const closeoutGuard = read('scripts/ps-289-multi-package-closeout-guard.ts');
const printQueueSchema = read('src/db/schema/print-queue.ts');

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

check('sidecar dry-run repository captured two package queue candidates',
  applied.length === 1 && applied[0]?.length === 2);
check('real print queue schema is currently unique on orderId/clientId',
  /unique\('print_queue_order_client_unq'\)\.on\(t\.orderId, t\.clientId\)/.test(printQueueSchema));
check('package-scoped order id format is deterministic',
  multiPackagePrintQueueOrderId({ orderId: 28901, packageSequence: 2, packageKey: 'pkg-b' }) === 'mp:28901:2:pkg-b');
check('print queue key helper matches current unique constraint',
  printQueueOrderClientKey({ orderId: 'mp:28901:2:pkg-b', clientId: 44 }) === 'mp:28901:2:pkg-b|44');
check('dry-run keeps one entry per purchased package',
  dryRun.entries.length === 2 && dryRun.group.packageCount === 2);
check('dry-run proves naive source order keys would collapse',
  dryRun.wouldCollapseWithSourceOrderId === true &&
    new Set(dryRun.entries.map((entry) => entry.sourceOrderUniqueKey)).size === 1);
check('dry-run avoids collapse with package-scoped real print queue order ids',
  dryRun.entries.every((entry) => entry.orderId.startsWith(`mp:${entry.sourceOrderId}:`)) &&
    new Set(dryRun.entries.map((entry) => entry.packageUniqueKey)).size === 2);
check('dry-run entries keep source order identity for future runtime integration',
  dryRun.entries.every((entry) => entry.sourceOrderId === 28901 && entry.orderNumber === 'PS289-ORDER'));
check('dry-run entries are real print queue shaped but not inserted',
  dryRun.entries.every((entry) =>
    entry.status === 'queued' &&
    entry.realPrintQueueInserted === false &&
    entry.id.startsWith('mpq:') &&
    entry.labelUrl.startsWith('/labels/mock/') &&
    entry.skuGroupId.startsWith('multi-package:')),
  dryRun.entries);
check('dry-run contract names current uniqueness constraint and no-write mode',
  dryRun.uniqueConstraint === 'print_queue_order_client_unq' &&
    dryRun.collisionAvoidance === 'package_scoped_order_id' &&
    dryRun.realPrintQueueInserted === false);

const duplicateKey = dryRun.entries[0]!.packageUniqueKey;
throws('dry-run rejects an existing real print queue package key',
  () => buildMultiPackageRealPrintQueueDryRun(sidecarPlan, { existingPrintQueueOrderClientKeys: [duplicateKey] }),
  /Duplicate real print queue package key/);

const nullClientPlan = {
  ...sidecarPlan,
  group: { ...sidecarPlan.group, clientId: null },
  entries: [{ ...sidecarPlan.entries[0]!, clientId: null }],
};
throws('dry-run rejects package entries without a client id',
  () => buildMultiPackageRealPrintQueueDryRun(nullClientPlan),
  /requires a client id/);

check('contract file stays pure and offline',
  /dry-run contract/.test(contractSrc) &&
    /without writing that table/.test(contractSrc) &&
    !/from ['"].*(db\/client|routes|connectors|marketplace|shipstation|shipp|easypost|walmart)/i.test(contractSrc) &&
    !/\.insert\(|\.update\(|\.delete\(|fetch\(/.test(contractSrc));
check('package wires PS-289 real print queue contract guard',
  hasScript(
    packageJson,
    'test:ps-289-multi-package-real-print-queue-contract',
    'tsx scripts/ps-289-multi-package-real-print-queue-contract-guard.ts',
  ));
check('status doc lists PS-289 real print queue contract guard',
  statusDoc.includes('`test:ps-289-multi-package-real-print-queue-contract`'));
check('status doc keeps real print queue insertion missing after dry-run proof',
  /dry-run real print queue contract now\s+exists/.test(statusDoc) &&
    /Real print queue insertion\/printer integration/.test(statusDoc) &&
    /not Final Review-ready/.test(statusDoc));
check('closeout guard includes the real print queue contract proof',
  closeoutGuard.includes('multi-package-real-print-queue-contract.ts') &&
    closeoutGuard.includes('test:ps-289-multi-package-real-print-queue-contract'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package real print queue contract guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package real print queue contract guard');
