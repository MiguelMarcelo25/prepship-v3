/**
 * PS-289 - pure multi-package marketplace confirmation planning.
 *
 * Converts mocked package labels into marketplace confirmation candidates.
 * No marketplace API calls, live notifications, provider calls, postage, print queue writes, or shipped/cancelled mutation happens here.
 */
import type {
  MockedMultiPackageLabel,
  MockedMultiPackageLabelFlow,
} from './multi-package-mock-label-flow';

export type MultiPackageMarketplaceConfirmationCandidate = {
  confirmationId: string;
  orderId: number;
  clientId: number | null;
  orderNumber: string | null;
  shipmentGroupKey: string;
  packageKey: string;
  packageSequence: number;
  labelIdempotencyKey: string;
  shipmentId: number;
  trackingNumber: string;
  carrierName: string;
  serviceLabel: string;
  provider: 'mock_multi_package';
  status: 'planned';
  isLiveNotification: false;
  marketplaceConfirmationPlanned: true;
};

export type MultiPackageMarketplaceConfirmationPlan = {
  group: {
    orderId: number;
    clientId: number | null;
    groupKey: string;
    status: 'marketplace_confirmation_planned';
    packageCount: number;
  };
  trackingNumbers: string[];
  confirmations: MultiPackageMarketplaceConfirmationCandidate[];
};

function optionalText(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function serviceLabel(label: MockedMultiPackageLabel, override: string | undefined): string {
  return override?.trim() || label.serviceLabel;
}

export function buildMultiPackageMarketplaceConfirmationPlan(
  flow: MockedMultiPackageLabelFlow,
  options: {
    carrierName?: string;
    serviceLabel?: string;
    orderNumber?: string | number | null;
    existingConfirmationLabelIdempotencyKeys?: string[];
  } = {},
): MultiPackageMarketplaceConfirmationPlan {
  const existing = new Set(options.existingConfirmationLabelIdempotencyKeys ?? []);
  const carrierName = options.carrierName?.trim() || 'Mock Carrier';
  const orderNumber = optionalText(options.orderNumber);

  const confirmations = flow.labels.map((label) => {
    if (existing.has(label.labelIdempotencyKey)) {
      throw new Error(
        `Package ${label.packageKey} already has a marketplace confirmation candidate: ${label.labelIdempotencyKey}`,
      );
    }

    return {
      confirmationId: `mpc:${label.labelIdempotencyKey}`,
      orderId: label.orderId,
      clientId: label.clientId,
      orderNumber,
      shipmentGroupKey: flow.group.groupKey,
      packageKey: label.packageKey,
      packageSequence: label.packageSequence,
      labelIdempotencyKey: label.labelIdempotencyKey,
      shipmentId: label.shipmentId,
      trackingNumber: label.trackingNumber,
      carrierName,
      serviceLabel: serviceLabel(label, options.serviceLabel),
      provider: 'mock_multi_package',
      status: 'planned',
      isLiveNotification: false,
      marketplaceConfirmationPlanned: true,
    } satisfies MultiPackageMarketplaceConfirmationCandidate;
  });

  return {
    group: {
      orderId: flow.group.orderId,
      clientId: flow.group.clientId,
      groupKey: flow.group.groupKey,
      status: 'marketplace_confirmation_planned',
      packageCount: flow.group.packageCount,
    },
    trackingNumbers: confirmations.map((entry) => entry.trackingNumber),
    confirmations,
  };
}
