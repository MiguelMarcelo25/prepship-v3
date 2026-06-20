/**
 * PS-289 - DB-backed mocked multi-package label orchestration.
 *
 * Mocked-only orchestration: no provider calls, postage, print queue, marketplace, or shipped/cancelled mutation.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { shipmentGroupPackages, shipmentGroups } from '../../db/schema/shipment-groups';
import {
  buildMultiPackagePersistenceDraft,
  type MultiPackagePersistenceDraft,
  type MultiPackageShipmentPlan,
} from './multi-package-shipment-plan';
import {
  buildMockedMultiPackageLabelFlow,
  type MockedMultiPackageLabel,
  type MockedMultiPackageLabelFlow,
} from './multi-package-mock-label-flow';

type PlannedGroup = MultiPackagePersistenceDraft['group'];
type PlannedPackage = MultiPackagePersistenceDraft['packages'][number];

export type PersistedMultiPackageGroup = {
  id: number;
  groupKey: string;
};

export type MultiPackageMockLabelOrchestrationRepository = {
  findExistingMockedLabelKeys(keys: string[]): Promise<string[]>;
  upsertPlannedGroup(group: PlannedGroup): Promise<PersistedMultiPackageGroup>;
  upsertPlannedPackages(groupId: number, packages: PlannedPackage[]): Promise<void>;
  applyMockedLabels(groupId: number, labels: MockedMultiPackageLabel[]): Promise<void>;
  markGroupMockLabelsCreated(groupId: number, packageCount: number): Promise<void>;
};

export type MockedMultiPackageOrchestrationResult = {
  groupId: number;
  flow: MockedMultiPackageLabelFlow;
};

export function createDbMultiPackageMockLabelOrchestrationRepository(): MultiPackageMockLabelOrchestrationRepository {
  return {
    async findExistingMockedLabelKeys(keys) {
      if (!keys.length) return [];
      const rows = await db
        .select({ key: shipmentGroupPackages.labelIdempotencyKey })
        .from(shipmentGroupPackages)
        .where(and(
          inArray(shipmentGroupPackages.labelIdempotencyKey, keys),
          eq(shipmentGroupPackages.status, 'mock_label_created'),
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

    async applyMockedLabels(groupId, labels) {
      for (const label of labels) {
        await db
          .update(shipmentGroupPackages)
          .set({
            status: 'mock_label_created',
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

    async markGroupMockLabelsCreated(groupId, packageCount) {
      await db
        .update(shipmentGroups)
        .set({
          status: 'mock_labels_created',
          packageCount,
          updatedAt: new Date(),
        })
        .where(eq(shipmentGroups.id, groupId));
    },
  };
}

export async function orchestrateMockedMultiPackageLabels(
  plan: MultiPackageShipmentPlan,
  options: {
    clientId?: number | null;
    serviceLabel?: string;
    repository?: MultiPackageMockLabelOrchestrationRepository;
  } = {},
): Promise<MockedMultiPackageOrchestrationResult> {
  const draft = buildMultiPackagePersistenceDraft(plan, { clientId: options.clientId });
  const repository = options.repository ?? createDbMultiPackageMockLabelOrchestrationRepository();
  const labelKeys = plan.packages.map((pkg) => pkg.labelIdempotencyKey);
  const existingKeys = await repository.findExistingMockedLabelKeys(labelKeys);
  if (existingKeys.length) {
    throw new Error(`Package already has a mocked label: ${existingKeys.join(', ')}`);
  }

  const group = await repository.upsertPlannedGroup(draft.group);
  await repository.upsertPlannedPackages(group.id, draft.packages);
  const flow = buildMockedMultiPackageLabelFlow(plan, {
    clientId: options.clientId,
    serviceLabel: options.serviceLabel,
  });
  await repository.applyMockedLabels(group.id, flow.labels);
  await repository.markGroupMockLabelsCreated(group.id, flow.labels.length);

  return { groupId: group.id, flow };
}
