/**
 * PS-289 - DB-backed purchased multi-package label sidecar orchestration.
 *
 * Persists purchased label results into additive shipment group sidecars.
 * No provider calls by default, no print queue writes, no marketplace API calls, and no shipped/cancelled mutation happens here.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { shipmentGroupPackages, shipmentGroups } from '../../db/schema/shipment-groups';
import {
  purchaseMultiPackageLabels,
  type MultiPackageLabelPurchaser,
  type MultiPackageLabelPurchaseFlow,
  type MultiPackagePurchasedLabel,
} from './multi-package-label-purchase-boundary';
import {
  buildMultiPackagePersistenceDraft,
  type MultiPackagePersistenceDraft,
  type MultiPackageShipmentPlan,
} from './multi-package-shipment-plan';

type PlannedGroup = MultiPackagePersistenceDraft['group'];
type PlannedPackage = MultiPackagePersistenceDraft['packages'][number];

export type PersistedPurchasedMultiPackageGroup = {
  id: number;
  groupKey: string;
};

export type MultiPackagePurchasedLabelOrchestrationRepository = {
  findExistingPurchasedLabelKeys(keys: string[]): Promise<string[]>;
  upsertPlannedGroup(group: PlannedGroup): Promise<PersistedPurchasedMultiPackageGroup>;
  upsertPlannedPackages(groupId: number, packages: PlannedPackage[]): Promise<void>;
  applyPurchasedLabels(groupId: number, labels: MultiPackagePurchasedLabel[]): Promise<void>;
  markGroupLabelsPurchased(groupId: number, packageCount: number, totalPostageCost: number): Promise<void>;
};

export type PurchasedMultiPackageLabelOrchestrationResult = {
  groupId: number;
  flow: MultiPackageLabelPurchaseFlow;
};

export function createDbMultiPackagePurchasedLabelOrchestrationRepository(): MultiPackagePurchasedLabelOrchestrationRepository {
  return {
    async findExistingPurchasedLabelKeys(keys) {
      if (!keys.length) return [];
      const rows = await db
        .select({ key: shipmentGroupPackages.labelIdempotencyKey })
        .from(shipmentGroupPackages)
        .where(and(
          inArray(shipmentGroupPackages.labelIdempotencyKey, keys),
          eq(shipmentGroupPackages.status, 'label_purchased'),
        ));
      return rows.map((row) => row.key);
    },

    async upsertPlannedGroup(group) {
      const [row] = await db
        .insert(shipmentGroups)
        .values({
          orderId: group.orderId,
          clientId: group.clientId,
          orderNumber: group.orderNumber,
          groupKey: group.groupKey,
          status: group.status,
          packageCount: group.packageCount,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: shipmentGroups.groupKey,
          set: {
            orderId: group.orderId,
            clientId: group.clientId,
            orderNumber: group.orderNumber,
            status: group.status,
            packageCount: group.packageCount,
            updatedAt: new Date(),
          },
        })
        .returning({ id: shipmentGroups.id, groupKey: shipmentGroups.groupKey });
      if (!row) throw new Error(`Failed to upsert shipment group ${group.groupKey}`);
      return row;
    },

    async upsertPlannedPackages(groupId, packages) {
      for (const pkg of packages) {
        await db
          .insert(shipmentGroupPackages)
          .values({
            shipmentGroupId: groupId,
            orderId: pkg.orderId,
            clientId: pkg.clientId,
            packageKey: pkg.packageKey,
            packageSequence: pkg.packageSequence,
            labelIdempotencyKey: pkg.labelIdempotencyKey,
            weightOz: pkg.weightOz,
            dimsL: pkg.dimsL,
            dimsW: pkg.dimsW,
            dimsH: pkg.dimsH,
            items: pkg.items,
            status: pkg.status,
            shipmentId: null,
            trackingNumber: null,
            labelUrl: null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [shipmentGroupPackages.shipmentGroupId, shipmentGroupPackages.packageKey],
            set: {
              orderId: pkg.orderId,
              clientId: pkg.clientId,
              packageSequence: pkg.packageSequence,
              labelIdempotencyKey: pkg.labelIdempotencyKey,
              weightOz: pkg.weightOz,
              dimsL: pkg.dimsL,
              dimsW: pkg.dimsW,
              dimsH: pkg.dimsH,
              items: pkg.items,
              status: pkg.status,
              shipmentId: null,
              trackingNumber: null,
              labelUrl: null,
              updatedAt: new Date(),
            },
          });
      }
    },

    async applyPurchasedLabels(groupId, labels) {
      for (const label of labels) {
        await db
          .update(shipmentGroupPackages)
          .set({
            status: 'label_purchased',
            shipmentId: label.shipmentId,
            trackingNumber: label.trackingNumber,
            labelUrl: label.labelUrl,
            updatedAt: new Date(),
          })
          .where(and(
            eq(shipmentGroupPackages.shipmentGroupId, groupId),
            eq(shipmentGroupPackages.labelIdempotencyKey, label.labelIdempotencyKey),
          ));
      }
    },

    async markGroupLabelsPurchased(groupId, packageCount, totalPostageCost) {
      await db
        .update(shipmentGroups)
        .set({
          status: 'labels_purchased',
          packageCount,
          metadata: {
            source: 'multi_package_label_purchase_boundary',
            totalPostageCost,
          },
          updatedAt: new Date(),
        })
        .where(eq(shipmentGroups.id, groupId));
    },
  };
}

export async function orchestratePurchasedMultiPackageLabels(
  plan: MultiPackageShipmentPlan,
  options: {
    clientId?: number | null;
    serviceLabel?: string;
    orderNumber?: string | number | null;
    purchaser?: MultiPackageLabelPurchaser;
    livePostageApproved?: boolean;
    repository?: MultiPackagePurchasedLabelOrchestrationRepository;
  } = {},
): Promise<PurchasedMultiPackageLabelOrchestrationResult> {
  if (!options.purchaser) {
    throw new Error('Purchased multi-package label orchestration requires an explicit purchaser dependency');
  }

  const draft = buildMultiPackagePersistenceDraft(plan, { clientId: options.clientId });
  const repository = options.repository ?? createDbMultiPackagePurchasedLabelOrchestrationRepository();
  const labelKeys = plan.packages.map((pkg) => pkg.labelIdempotencyKey);
  const existingKeys = await repository.findExistingPurchasedLabelKeys(labelKeys);
  if (existingKeys.length) {
    throw new Error(`Package already has a purchased label: ${existingKeys.join(', ')}`);
  }

  const group = await repository.upsertPlannedGroup(draft.group);
  await repository.upsertPlannedPackages(group.id, draft.packages);
  const flow = await purchaseMultiPackageLabels(plan, {
    clientId: options.clientId,
    serviceLabel: options.serviceLabel,
    orderNumber: options.orderNumber,
    purchaser: options.purchaser,
    livePostageApproved: options.livePostageApproved,
  });
  await repository.applyPurchasedLabels(group.id, flow.labels);
  await repository.markGroupLabelsPurchased(group.id, flow.labels.length, flow.totalPostageCost);

  return { groupId: group.id, flow };
}
