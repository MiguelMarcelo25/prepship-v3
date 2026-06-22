/**
 * PS-289 - dry-run contract for real print queue insertion.
 *
 * This maps purchased multi-package label sidecar entries into the shape the
 * real print_queue_orders inserter would need, without writing that table,
 * calling a printer, buying postage, notifying marketplaces, or mutating
 * shipped/cancelled data.
 */
import type {
  MultiPackagePrintQueueSidecarEntry,
  MultiPackagePrintQueueSidecarPlan,
} from './multi-package-print-queue-sidecar';

export type MultiPackageRealPrintQueueDryRunEntry = {
  id: string;
  clientId: number;
  orderId: string;
  sourceOrderId: number;
  orderNumber: string | null;
  labelUrl: string;
  skuGroupId: string;
  primarySku: string | null;
  itemDescription: string;
  orderQty: number;
  multiSkuData: null;
  status: 'queued';
  packageKey: string;
  packageSequence: number;
  labelIdempotencyKey: string;
  trackingNumber: string;
  packageUniqueKey: string;
  sourceOrderUniqueKey: string;
  realPrintQueueInserted: false;
};

export type MultiPackageRealPrintQueueDryRun = {
  group: {
    orderId: number;
    clientId: number;
    orderNumber: string | null;
    groupKey: string;
    packageCount: number;
  };
  entries: MultiPackageRealPrintQueueDryRunEntry[];
  uniqueConstraint: 'print_queue_order_client_unq';
  collisionAvoidance: 'package_scoped_order_id';
  wouldCollapseWithSourceOrderId: boolean;
  realPrintQueueInserted: false;
};

export function multiPackagePrintQueueOrderId(entry: {
  orderId: number;
  packageSequence: number;
  packageKey: string;
}): string {
  return `mp:${entry.orderId}:${entry.packageSequence}:${entry.packageKey}`;
}

export function printQueueOrderClientKey(input: { orderId: string; clientId: number }): string {
  return `${input.orderId}|${input.clientId}`;
}

function positiveQuantity(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function realPrintQueueEntryFromSidecar(
  entry: MultiPackagePrintQueueSidecarEntry,
): MultiPackageRealPrintQueueDryRunEntry {
  const clientId = entry.clientId;
  if (clientId == null || !Number.isInteger(clientId)) {
    throw new Error(`Multi-package print queue insertion requires a client id for package ${entry.packageKey}`);
  }
  const labelUrl = entry.labelUrl.trim();
  if (!labelUrl) {
    throw new Error(`Multi-package print queue insertion requires a label URL for package ${entry.packageKey}`);
  }

  const orderId = multiPackagePrintQueueOrderId(entry);
  return {
    id: entry.queueId,
    clientId,
    orderId,
    sourceOrderId: entry.orderId,
    orderNumber: entry.orderNumber,
    labelUrl,
    skuGroupId: entry.skuGroupId,
    primarySku: entry.primarySku,
    itemDescription: entry.itemDescription,
    orderQty: positiveQuantity(entry.orderQty),
    multiSkuData: null,
    status: 'queued',
    packageKey: entry.packageKey,
    packageSequence: entry.packageSequence,
    labelIdempotencyKey: entry.labelIdempotencyKey,
    trackingNumber: entry.trackingNumber,
    packageUniqueKey: printQueueOrderClientKey({ orderId, clientId }),
    sourceOrderUniqueKey: printQueueOrderClientKey({
      orderId: String(entry.orderId),
      clientId,
    }),
    realPrintQueueInserted: false,
  };
}

export function buildMultiPackageRealPrintQueueDryRun(
  plan: MultiPackagePrintQueueSidecarPlan,
  options: {
    existingPrintQueueOrderClientKeys?: string[];
  } = {},
): MultiPackageRealPrintQueueDryRun {
  const entries = plan.entries.map((entry) => realPrintQueueEntryFromSidecar(entry));
  const sourceKeys = new Set<string>();
  const packageKeys = new Set<string>();
  const existing = new Set(options.existingPrintQueueOrderClientKeys ?? []);

  for (const entry of entries) {
    sourceKeys.add(entry.sourceOrderUniqueKey);
    if (packageKeys.has(entry.packageUniqueKey) || existing.has(entry.packageUniqueKey)) {
      throw new Error(`Duplicate real print queue package key: ${entry.packageUniqueKey}`);
    }
    packageKeys.add(entry.packageUniqueKey);
  }

  const clientId = entries[0]?.clientId;
  if (clientId == null || !Number.isInteger(clientId)) {
    throw new Error('Multi-package print queue insertion requires at least one package entry with a client id');
  }

  return {
    group: {
      orderId: plan.group.orderId,
      clientId,
      orderNumber: plan.group.orderNumber,
      groupKey: plan.group.groupKey,
      packageCount: plan.group.packageCount,
    },
    entries,
    uniqueConstraint: 'print_queue_order_client_unq',
    collisionAvoidance: 'package_scoped_order_id',
    wouldCollapseWithSourceOrderId: sourceKeys.size !== entries.length,
    realPrintQueueInserted: false,
  };
}
