/**
 * PS-289 - pure mocked multi-package label workflow.
 *
 * This is an offline workflow proof for package-level label identity.
 * No provider calls, postage, print queue, marketplace, or shipped/cancelled mutation happens here.
 */
import type {
  MultiPackageShipmentPlan,
  PlannedShipmentPackage,
} from './multi-package-shipment-plan';

export type MockedMultiPackageLabel = {
  orderId: number;
  clientId: number | null;
  packageKey: string;
  packageSequence: number;
  labelIdempotencyKey: string;
  shipmentId: number;
  trackingNumber: string;
  labelUrl: string;
  serviceLabel: string;
  provider: 'mock_multi_package';
  postageCost: 0;
  isLivePostage: false;
  marketplaceConfirmationPlanned: false;
  weightOz: number | null;
  dimensions: PlannedShipmentPackage['dimensions'];
  items: PlannedShipmentPackage['items'];
};

export type MockedMultiPackageLabelFlow = {
  group: {
    orderId: number;
    clientId: number | null;
    groupKey: string;
    status: 'mock_labels_created';
    packageCount: number;
  };
  labels: MockedMultiPackageLabel[];
};

function persistedOrderId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error('A persisted numeric orderId is required for mocked multi-package labels');
  }
  return parsed;
}

function stableHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicShipmentId(labelIdempotencyKey: string): number {
  return -(1_000_000 + (stableHash(`shipment:${labelIdempotencyKey}`) % 8_999_999));
}

function deterministicTrackingNumber(labelIdempotencyKey: string): string {
  const first = String(stableHash(`track-a:${labelIdempotencyKey}`)).padStart(10, '0');
  const second = String(stableHash(`track-b:${labelIdempotencyKey}`)).padStart(10, '0');
  return `TESTMP${(first + second).slice(0, 18)}`;
}

export function buildMockedMultiPackageLabelFlow(
  plan: MultiPackageShipmentPlan,
  options: {
    clientId?: number | null;
    serviceLabel?: string;
    existingLabelIdempotencyKeys?: string[];
  } = {},
): MockedMultiPackageLabelFlow {
  const orderId = persistedOrderId(plan.orderId);
  const clientId = Number.isInteger(options.clientId) ? options.clientId! : null;
  const serviceLabel = options.serviceLabel?.trim() || 'MOCK MULTI-PACKAGE';
  const existing = new Set(options.existingLabelIdempotencyKeys ?? []);

  const labels = plan.packages.map((pkg) => {
    if (existing.has(pkg.labelIdempotencyKey)) {
      throw new Error(`Package ${pkg.packageKey} already has a mocked label: ${pkg.labelIdempotencyKey}`);
    }

    return {
      orderId,
      clientId,
      packageKey: pkg.packageKey,
      packageSequence: pkg.packageSequence,
      labelIdempotencyKey: pkg.labelIdempotencyKey,
      shipmentId: deterministicShipmentId(pkg.labelIdempotencyKey),
      trackingNumber: deterministicTrackingNumber(pkg.labelIdempotencyKey),
      labelUrl: `mock://multi-package/${encodeURIComponent(pkg.labelIdempotencyKey)}`,
      serviceLabel,
      provider: 'mock_multi_package',
      postageCost: 0,
      isLivePostage: false,
      marketplaceConfirmationPlanned: false,
      weightOz: pkg.weightOz,
      dimensions: pkg.dimensions,
      items: pkg.items,
    } satisfies MockedMultiPackageLabel;
  });

  return {
    group: {
      orderId,
      clientId,
      groupKey: plan.shipmentGroupKey,
      status: 'mock_labels_created',
      packageCount: plan.packageCount,
    },
    labels,
  };
}
