/**
 * PS-289 - pure multi-package shipment group planning.
 *
 * This is the first backend-owned source of truth for package groups. It is
 * intentionally small and side-effect free.
 * No label purchase, postage, queue, marketplace, or shipped/cancelled mutation happens here.
 */

export type MultiPackagePlanMode = 'single_package' | 'multi_package';

export type MultiPackagePlanItem = {
  sku?: string | null;
  itemId?: string | number | null;
  quantity?: number | null;
};

export type MultiPackagePlanDimensions = {
  length?: number | null;
  width?: number | null;
  height?: number | null;
};

export type MultiPackagePlanInputPackage = {
  packageKey?: string | number | null;
  weightOz?: number | null;
  dimensions?: MultiPackagePlanDimensions | null;
  items?: MultiPackagePlanItem[] | null;
};

export type MultiPackageShipmentPlanInput = {
  orderId: string | number;
  orderNumber?: string | number | null;
  packages: MultiPackagePlanInputPackage[];
};

export type PlannedShipmentPackage = {
  packageKey: string;
  packageSequence: number;
  labelIdempotencyKey: string;
  weightOz: number | null;
  dimensions: {
    length: number | null;
    width: number | null;
    height: number | null;
  };
  items: Array<{
    sku: string | null;
    itemId: string | number | null;
    quantity: number | null;
  }>;
};

export type MultiPackageShipmentPlan = {
  mode: MultiPackagePlanMode;
  orderId: string;
  orderNumber: string | null;
  shipmentGroupKey: string;
  packageCount: number;
  packages: PlannedShipmentPackage[];
};

function stableText(value: string | number): string {
  return String(value).trim();
}

function normalizePackageKey(value: string | number | null | undefined, fallbackSequence: number): string {
  const raw = String(value ?? '').trim();
  const text = raw || `package-${fallbackSequence}`;
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `package-${fallbackSequence}`;
}

function finitePositiveOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nullableFinite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function multiPackageLabelIdempotencyKey(input: {
  orderId: string | number;
  packageKey: string;
}): string {
  const orderId = stableText(input.orderId);
  const packageKey = normalizePackageKey(input.packageKey, 1);
  if (!orderId) throw new Error('orderId is required for multi-package label idempotency');
  return `order:${orderId}:package:${packageKey}`;
}

export function buildMultiPackageShipmentPlan(input: MultiPackageShipmentPlanInput): MultiPackageShipmentPlan {
  const orderId = stableText(input.orderId);
  if (!orderId) throw new Error('orderId is required for multi-package shipment planning');
  if (!Array.isArray(input.packages) || input.packages.length === 0) {
    throw new Error('At least one package is required for multi-package shipment planning');
  }

  const seenPackageKeys = new Set<string>();
  const packages = input.packages.map((pkg, index): PlannedShipmentPackage => {
    const packageSequence = index + 1;
    const packageKey = normalizePackageKey(pkg.packageKey, packageSequence);
    if (seenPackageKeys.has(packageKey)) {
      throw new Error(`Duplicate package key for order ${orderId}: ${packageKey}`);
    }
    seenPackageKeys.add(packageKey);

    return {
      packageKey,
      packageSequence,
      labelIdempotencyKey: multiPackageLabelIdempotencyKey({ orderId, packageKey }),
      weightOz: finitePositiveOrNull(pkg.weightOz),
      dimensions: {
        length: finitePositiveOrNull(pkg.dimensions?.length),
        width: finitePositiveOrNull(pkg.dimensions?.width),
        height: finitePositiveOrNull(pkg.dimensions?.height),
      },
      items: (pkg.items ?? []).map((item) => ({
        sku: typeof item.sku === 'string' && item.sku.trim() ? item.sku.trim() : null,
        itemId: item.itemId ?? null,
        quantity: nullableFinite(item.quantity),
      })),
    };
  });

  return {
    mode: packages.length > 1 ? 'multi_package' : 'single_package',
    orderId,
    orderNumber: input.orderNumber == null ? null : stableText(input.orderNumber),
    shipmentGroupKey: `order:${orderId}`,
    packageCount: packages.length,
    packages,
  };
}
