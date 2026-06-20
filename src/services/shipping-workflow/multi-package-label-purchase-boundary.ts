/**
 * PS-289 - per-package label purchase boundary.
 *
 * This owner shapes one purchase request per planned package and validates the returned package label identity.
 * No default provider calls, live postage, print queue writes, marketplace API calls, or shipped/cancelled mutation happens here.
 */
import type {
  MultiPackageShipmentPlan,
  PlannedShipmentPackage,
} from './multi-package-shipment-plan';

export type MultiPackageLabelPurchaseRequest = {
  orderId: number;
  clientId: number | null;
  orderNumber: string | null;
  shipmentGroupKey: string;
  packageKey: string;
  packageSequence: number;
  labelIdempotencyKey: string;
  weightOz: number | null;
  dimensions: PlannedShipmentPackage['dimensions'];
  items: PlannedShipmentPackage['items'];
  serviceLabel: string;
};

export type MultiPackageLabelPurchaseResult = {
  labelIdempotencyKey: string;
  shipmentId: number;
  trackingNumber: string;
  labelUrl: string;
  provider: string;
  postageCost: number;
  isLivePostage: boolean;
};

export type MultiPackageLabelPurchaser = (
  request: MultiPackageLabelPurchaseRequest,
) => Promise<MultiPackageLabelPurchaseResult>;

export type MultiPackagePurchasedLabel = MultiPackageLabelPurchaseRequest & MultiPackageLabelPurchaseResult & {
  status: 'purchased';
};

export type MultiPackageLabelPurchaseFlow = {
  group: {
    orderId: number;
    clientId: number | null;
    orderNumber: string | null;
    groupKey: string;
    status: 'labels_purchased';
    packageCount: number;
  };
  labels: MultiPackagePurchasedLabel[];
  totalPostageCost: number;
};

function persistedOrderId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error('A persisted numeric orderId is required for multi-package label purchase');
  }
  return parsed;
}

function optionalText(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function validatePurchaseResult(
  request: MultiPackageLabelPurchaseRequest,
  result: MultiPackageLabelPurchaseResult,
  livePostageApproved: boolean,
): MultiPackageLabelPurchaseResult {
  if (result.labelIdempotencyKey !== request.labelIdempotencyKey) {
    throw new Error(
      `Purchaser returned a mismatched label idempotency key for package ${request.packageKey}: ${result.labelIdempotencyKey}`,
    );
  }
  if (result.isLivePostage && !livePostageApproved) {
    throw new Error('Live multi-package postage requires explicit approval');
  }
  if (!Number.isFinite(result.shipmentId)) {
    throw new Error(`Purchaser returned an invalid shipment id for package ${request.packageKey}`);
  }
  if (!result.trackingNumber.trim()) {
    throw new Error(`Purchaser returned an empty tracking number for package ${request.packageKey}`);
  }
  if (!result.labelUrl.trim()) {
    throw new Error(`Purchaser returned an empty label URL for package ${request.packageKey}`);
  }
  if (!result.provider.trim()) {
    throw new Error(`Purchaser returned an empty provider for package ${request.packageKey}`);
  }
  if (!Number.isFinite(result.postageCost) || result.postageCost < 0) {
    throw new Error(`Purchaser returned an invalid postage cost for package ${request.packageKey}`);
  }
  return {
    ...result,
    trackingNumber: result.trackingNumber.trim(),
    labelUrl: result.labelUrl.trim(),
    provider: result.provider.trim(),
    postageCost: cents(result.postageCost),
  };
}

export async function purchaseMultiPackageLabels(
  plan: MultiPackageShipmentPlan,
  options: {
    clientId?: number | null;
    serviceLabel?: string;
    orderNumber?: string | number | null;
    purchaser?: MultiPackageLabelPurchaser;
    existingLabelIdempotencyKeys?: string[];
    livePostageApproved?: boolean;
  } = {},
): Promise<MultiPackageLabelPurchaseFlow> {
  const orderId = persistedOrderId(plan.orderId);
  const clientId = Number.isInteger(options.clientId) ? options.clientId! : null;
  const orderNumber = options.orderNumber === undefined ? plan.orderNumber : optionalText(options.orderNumber);
  const serviceLabel = options.serviceLabel?.trim() || 'MULTI-PACKAGE LABEL';
  const existing = new Set(options.existingLabelIdempotencyKeys ?? []);

  for (const pkg of plan.packages) {
    if (existing.has(pkg.labelIdempotencyKey)) {
      throw new Error(`Package ${pkg.packageKey} already has a purchased label: ${pkg.labelIdempotencyKey}`);
    }
  }

  if (!options.purchaser) {
    throw new Error('Multi-package label purchase requires an explicit purchaser dependency');
  }

  const labels: MultiPackagePurchasedLabel[] = [];
  for (const pkg of plan.packages) {
    const request: MultiPackageLabelPurchaseRequest = {
      orderId,
      clientId,
      orderNumber,
      shipmentGroupKey: plan.shipmentGroupKey,
      packageKey: pkg.packageKey,
      packageSequence: pkg.packageSequence,
      labelIdempotencyKey: pkg.labelIdempotencyKey,
      weightOz: pkg.weightOz,
      dimensions: pkg.dimensions,
      items: pkg.items,
      serviceLabel,
    };
    const result = validatePurchaseResult(
      request,
      await options.purchaser(request),
      options.livePostageApproved === true,
    );
    labels.push({
      ...request,
      ...result,
      status: 'purchased',
    });
  }

  return {
    group: {
      orderId,
      clientId,
      orderNumber,
      groupKey: plan.shipmentGroupKey,
      status: 'labels_purchased',
      packageCount: plan.packageCount,
    },
    labels,
    totalPostageCost: cents(labels.reduce((sum, label) => sum + label.postageCost, 0)),
  };
}
