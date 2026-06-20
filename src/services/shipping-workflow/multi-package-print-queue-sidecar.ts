/**
 * PS-289 - package-aware print queue sidecar orchestration.
 *
 * Persists print queue candidates into additive shipment group sidecars.
 * No real print queue table writes, printer calls, provider calls, marketplace API calls, or shipped/cancelled mutation happens here.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { shipmentGroupPackages, shipmentGroups } from '../../db/schema/shipment-groups';
import type {
  MultiPackageLabelPurchaseFlow,
  MultiPackagePurchasedLabel,
} from './multi-package-label-purchase-boundary';

export type MultiPackagePrintQueueSidecarEntry = {
  queueId: string;
  orderId: number;
  clientId: number | null;
  orderNumber: string | null;
  shipmentGroupKey: string;
  packageKey: string;
  packageSequence: number;
  labelIdempotencyKey: string;
  shipmentId: number;
  labelUrl: string;
  trackingNumber: string;
  skuGroupId: string;
  primarySku: string | null;
  itemDescription: string;
  orderQty: number;
  status: 'print_queue_sidecar_planned';
  provider: string;
  isLivePostage: boolean;
  realPrintQueueInserted: false;
};

export type MultiPackagePrintQueueSidecarPlan = {
  group: {
    orderId: number;
    clientId: number | null;
    orderNumber: string | null;
    groupKey: string;
    status: 'print_queue_sidecar_planned';
    packageCount: number;
  };
  entries: MultiPackagePrintQueueSidecarEntry[];
};

export type MultiPackagePrintQueueSidecarRepository = {
  findExistingQueuedLabelKeys(keys: string[]): Promise<string[]>;
  applyPrintQueueCandidates(groupId: number, entries: MultiPackagePrintQueueSidecarEntry[]): Promise<void>;
  markGroupPrintQueuePlanned(groupId: number, packageCount: number, queueIds: string[]): Promise<void>;
};

function quantity(value: number | null): number {
  return Number.isFinite(value) && value != null && value > 0 ? value : 1;
}

function summarizeItems(label: MultiPackagePurchasedLabel): {
  primarySku: string | null;
  itemDescription: string;
  orderQty: number;
} {
  const items = label.items.filter((item) => item.sku && quantity(item.quantity) > 0);
  if (!items.length) {
    return {
      primarySku: null,
      itemDescription: `Package ${label.packageSequence}`,
      orderQty: 1,
    };
  }

  const orderQty = items.reduce((sum, item) => sum + quantity(item.quantity), 0);
  const primarySku = items[0]?.sku ?? null;
  const itemDescription = items.map((item) => `${item.sku} x${quantity(item.quantity)}`).join(', ');
  return { primarySku, itemDescription, orderQty };
}

function buildSidecarEntries(flow: MultiPackageLabelPurchaseFlow): MultiPackagePrintQueueSidecarEntry[] {
  return flow.labels.map((label) => {
    const summary = summarizeItems(label);
    return {
      queueId: `mpq:${label.labelIdempotencyKey}`,
      orderId: label.orderId,
      clientId: label.clientId,
      orderNumber: label.orderNumber,
      shipmentGroupKey: label.shipmentGroupKey,
      packageKey: label.packageKey,
      packageSequence: label.packageSequence,
      labelIdempotencyKey: label.labelIdempotencyKey,
      shipmentId: label.shipmentId,
      labelUrl: label.labelUrl,
      trackingNumber: label.trackingNumber,
      skuGroupId: `multi-package:${label.packageKey}`,
      primarySku: summary.primarySku,
      itemDescription: summary.itemDescription,
      orderQty: summary.orderQty,
      status: 'print_queue_sidecar_planned',
      provider: label.provider,
      isLivePostage: label.isLivePostage,
      realPrintQueueInserted: false,
    } satisfies MultiPackagePrintQueueSidecarEntry;
  });
}

export function createDbMultiPackagePrintQueueSidecarRepository(): MultiPackagePrintQueueSidecarRepository {
  return {
    async findExistingQueuedLabelKeys(keys) {
      if (!keys.length) return [];
      const rows = await db
        .select({ key: shipmentGroupPackages.labelIdempotencyKey })
        .from(shipmentGroupPackages)
        .where(and(
          inArray(shipmentGroupPackages.labelIdempotencyKey, keys),
          eq(shipmentGroupPackages.status, 'print_queue_sidecar_planned'),
        ));
      return rows.map((row) => row.key);
    },

    async applyPrintQueueCandidates(groupId, entries) {
      for (const entry of entries) {
        await db
          .update(shipmentGroupPackages)
          .set({
            status: 'print_queue_sidecar_planned',
            shipmentId: entry.shipmentId,
            trackingNumber: entry.trackingNumber,
            labelUrl: entry.labelUrl,
            updatedAt: new Date(),
          })
          .where(and(
            eq(shipmentGroupPackages.shipmentGroupId, groupId),
            eq(shipmentGroupPackages.labelIdempotencyKey, entry.labelIdempotencyKey),
          ));
      }
    },

    async markGroupPrintQueuePlanned(groupId, packageCount, queueIds) {
      await db
        .update(shipmentGroups)
        .set({
          status: 'print_queue_sidecar_planned',
          packageCount,
          metadata: {
            source: 'multi_package_print_queue_sidecar',
            queueIds,
            realPrintQueueInserted: false,
          },
          updatedAt: new Date(),
        })
        .where(eq(shipmentGroups.id, groupId));
    },
  };
}

export async function orchestrateMultiPackagePrintQueueSidecar(
  groupId: number,
  flow: MultiPackageLabelPurchaseFlow,
  options: {
    repository?: MultiPackagePrintQueueSidecarRepository;
  } = {},
): Promise<MultiPackagePrintQueueSidecarPlan> {
  const repository = options.repository ?? createDbMultiPackagePrintQueueSidecarRepository();
  const labelKeys = flow.labels.map((label) => label.labelIdempotencyKey);
  const existingKeys = await repository.findExistingQueuedLabelKeys(labelKeys);
  if (existingKeys.length) {
    throw new Error(`Package already has a print queue sidecar candidate: ${existingKeys.join(', ')}`);
  }

  const entries = buildSidecarEntries(flow);
  await repository.applyPrintQueueCandidates(groupId, entries);
  await repository.markGroupPrintQueuePlanned(groupId, entries.length, entries.map((entry) => entry.queueId));

  return {
    group: {
      orderId: flow.group.orderId,
      clientId: flow.group.clientId,
      orderNumber: flow.group.orderNumber,
      groupKey: flow.group.groupKey,
      status: 'print_queue_sidecar_planned',
      packageCount: flow.group.packageCount,
    },
    entries,
  };
}
