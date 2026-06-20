/**
 * PS-289 - package-aware marketplace confirmation sidecar orchestration.
 *
 * Persists marketplace confirmation candidates into additive shipment group sidecars.
 * No marketplace API calls, live marketplace notifications, provider calls, real print queue writes, or shipped/cancelled mutation happens here.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { shipmentGroupPackages, shipmentGroups } from '../../db/schema/shipment-groups';
import type {
  MultiPackageLabelPurchaseFlow,
  MultiPackagePurchasedLabel,
} from './multi-package-label-purchase-boundary';

export type MultiPackageMarketplaceConfirmationSidecarEntry = {
  confirmationId: string;
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
  carrierName: string;
  serviceLabel: string;
  provider: string;
  status: 'marketplace_confirmation_sidecar_planned';
  isLivePostage: boolean;
  realMarketplaceNotificationSent: false;
};

export type MultiPackageMarketplaceConfirmationSidecarPlan = {
  group: {
    orderId: number;
    clientId: number | null;
    orderNumber: string | null;
    groupKey: string;
    status: 'marketplace_confirmation_sidecar_planned';
    packageCount: number;
  };
  trackingNumbers: string[];
  confirmations: MultiPackageMarketplaceConfirmationSidecarEntry[];
};

export type MultiPackageMarketplaceConfirmationSidecarRepository = {
  findExistingMarketplaceConfirmationKeys(keys: string[]): Promise<string[]>;
  applyMarketplaceConfirmationCandidates(
    groupId: number,
    entries: MultiPackageMarketplaceConfirmationSidecarEntry[],
  ): Promise<void>;
  markGroupMarketplaceConfirmationPlanned(
    groupId: number,
    packageCount: number,
    trackingNumbers: string[],
  ): Promise<void>;
};

function serviceLabel(label: MultiPackagePurchasedLabel, override: string | undefined): string {
  return override?.trim() || label.serviceLabel;
}

function buildSidecarEntries(
  flow: MultiPackageLabelPurchaseFlow,
  options: {
    carrierName?: string;
    serviceLabel?: string;
  } = {},
): MultiPackageMarketplaceConfirmationSidecarEntry[] {
  const carrierName = options.carrierName?.trim() || 'Mock Carrier';

  return flow.labels.map((label) => ({
    confirmationId: `mpc:${label.labelIdempotencyKey}`,
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
    carrierName,
    serviceLabel: serviceLabel(label, options.serviceLabel),
    provider: label.provider,
    status: 'marketplace_confirmation_sidecar_planned',
    isLivePostage: label.isLivePostage,
    realMarketplaceNotificationSent: false,
  } satisfies MultiPackageMarketplaceConfirmationSidecarEntry));
}

export function createDbMultiPackageMarketplaceConfirmationSidecarRepository(): MultiPackageMarketplaceConfirmationSidecarRepository {
  return {
    async findExistingMarketplaceConfirmationKeys(keys) {
      if (!keys.length) return [];
      const rows = await db
        .select({ key: shipmentGroupPackages.labelIdempotencyKey })
        .from(shipmentGroupPackages)
        .where(and(
          inArray(shipmentGroupPackages.labelIdempotencyKey, keys),
          eq(shipmentGroupPackages.status, 'marketplace_confirmation_sidecar_planned'),
        ));
      return rows.map((row) => row.key);
    },

    async applyMarketplaceConfirmationCandidates(groupId, entries) {
      for (const entry of entries) {
        await db
          .update(shipmentGroupPackages)
          .set({
            status: 'marketplace_confirmation_sidecar_planned',
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

    async markGroupMarketplaceConfirmationPlanned(groupId, packageCount, trackingNumbers) {
      await db
        .update(shipmentGroups)
        .set({
          status: 'marketplace_confirmation_sidecar_planned',
          packageCount,
          metadata: {
            source: 'multi_package_marketplace_confirmation_sidecar',
            trackingNumbers,
            realMarketplaceNotificationSent: false,
          },
          updatedAt: new Date(),
        })
        .where(eq(shipmentGroups.id, groupId));
    },
  };
}

export async function orchestrateMultiPackageMarketplaceConfirmationSidecar(
  groupId: number,
  flow: MultiPackageLabelPurchaseFlow,
  options: {
    repository?: MultiPackageMarketplaceConfirmationSidecarRepository;
    carrierName?: string;
    serviceLabel?: string;
  } = {},
): Promise<MultiPackageMarketplaceConfirmationSidecarPlan> {
  const repository = options.repository ?? createDbMultiPackageMarketplaceConfirmationSidecarRepository();
  const labelKeys = flow.labels.map((label) => label.labelIdempotencyKey);
  const existingKeys = await repository.findExistingMarketplaceConfirmationKeys(labelKeys);
  if (existingKeys.length) {
    throw new Error(`Package already has a marketplace confirmation sidecar candidate: ${existingKeys.join(', ')}`);
  }

  const confirmations = buildSidecarEntries(flow, {
    carrierName: options.carrierName,
    serviceLabel: options.serviceLabel,
  });
  const trackingNumbers = confirmations.map((entry) => entry.trackingNumber);
  await repository.applyMarketplaceConfirmationCandidates(groupId, confirmations);
  await repository.markGroupMarketplaceConfirmationPlanned(groupId, confirmations.length, trackingNumbers);

  return {
    group: {
      orderId: flow.group.orderId,
      clientId: flow.group.clientId,
      orderNumber: flow.group.orderNumber,
      groupKey: flow.group.groupKey,
      status: 'marketplace_confirmation_sidecar_planned',
      packageCount: flow.group.packageCount,
    },
    trackingNumbers,
    confirmations,
  };
}
