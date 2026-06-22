/**
 * PS-289 - pure multi-package review DTO.
 *
 * Backend-owned read model for future package-group review UI/API consumers.
 * No DB reads/writes, provider calls, postage, print queue writes, marketplace
 * notifications, or shipped/cancelled mutation happens here.
 */
import type {
  MultiPackageLabelPurchaseFlow,
  MultiPackagePurchasedLabel,
} from './multi-package-label-purchase-boundary';
import type {
  MultiPackageMarketplaceConfirmationSidecarEntry,
  MultiPackageMarketplaceConfirmationSidecarPlan,
} from './multi-package-marketplace-confirmation-sidecar';
import type {
  MultiPackagePrintQueueSidecarEntry,
  MultiPackagePrintQueueSidecarPlan,
} from './multi-package-print-queue-sidecar';
import type {
  MultiPackageShipmentPlan,
  PlannedShipmentPackage,
} from './multi-package-shipment-plan';

export type MultiPackageReviewStatus =
  | 'planned'
  | 'label_purchased'
  | 'print_queue_sidecar_planned'
  | 'marketplace_confirmation_sidecar_planned';

export type MultiPackageReviewLabelSource =
  | 'label_flow'
  | 'print_queue_sidecar'
  | 'marketplace_confirmation_sidecar';

export type MultiPackageReviewLabelFacts = {
  source: MultiPackageReviewLabelSource;
  shipmentId: number;
  trackingNumber: string;
  labelUrl: string;
  provider: string;
  serviceLabel: string | null;
  isLivePostage: boolean;
};

export type MultiPackageReviewPackageRow = {
  packageKey: string;
  packageSequence: number;
  labelIdempotencyKey: string;
  status: MultiPackageReviewStatus;
  weightOz: number | null;
  dimensions: PlannedShipmentPackage['dimensions'];
  items: PlannedShipmentPackage['items'];
  label: MultiPackageReviewLabelFacts | null;
  printQueue: {
    queueId: string;
    skuGroupId: string;
    primarySku: string | null;
    itemDescription: string;
    orderQty: number;
    realPrintQueueInserted: false;
  } | null;
  marketplaceConfirmation: {
    confirmationId: string;
    carrierName: string;
    serviceLabel: string;
    trackingNumber: string;
    realMarketplaceNotificationSent: false;
  } | null;
  missing: string[];
  readyForOperatorReview: boolean;
};

export type MultiPackageReviewDto = {
  group: {
    orderId: string;
    orderNumber: string | null;
    groupKey: string;
    packageCount: number;
  };
  packages: MultiPackageReviewPackageRow[];
  summary: {
    totalPackages: number;
    labelPackageCount: number;
    printQueuePackageCount: number;
    marketplaceConfirmationPackageCount: number;
    readyForOperatorReviewCount: number;
    livePostagePackageCount: number;
    allPackagesReadyForOperatorReview: boolean;
  };
  safety: {
    realPrintQueueInserted: false;
    realMarketplaceNotificationSent: false;
    hasLivePostage: boolean;
  };
};

function assertGroupMatchesPlan(
  source: string,
  plan: MultiPackageShipmentPlan,
  group: {
    orderId: number;
    groupKey: string;
    packageCount: number;
  },
): void {
  if (String(group.orderId) !== plan.orderId) {
    throw new Error(`${source} order id does not match the multi-package plan`);
  }
  if (group.groupKey !== plan.shipmentGroupKey) {
    throw new Error(`${source} group key does not match the multi-package plan`);
  }
  if (group.packageCount !== plan.packageCount) {
    throw new Error(`${source} package count does not match the multi-package plan`);
  }
}

function planKeySet(plan: MultiPackageShipmentPlan): Set<string> {
  return new Set(plan.packages.map((pkg) => pkg.labelIdempotencyKey));
}

function indexByPackageKey<T>(
  source: string,
  planKeys: Set<string>,
  rows: T[],
  keyOf: (row: T) => string,
): Map<string, T> {
  const index = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!planKeys.has(key)) {
      throw new Error(`${source} contains package label key outside the multi-package plan: ${key}`);
    }
    if (index.has(key)) {
      throw new Error(`${source} contains duplicate package label key: ${key}`);
    }
    index.set(key, row);
  }
  return index;
}

function labelFromPurchase(label: MultiPackagePurchasedLabel): MultiPackageReviewLabelFacts {
  return {
    source: 'label_flow',
    shipmentId: label.shipmentId,
    trackingNumber: label.trackingNumber,
    labelUrl: label.labelUrl,
    provider: label.provider,
    serviceLabel: label.serviceLabel,
    isLivePostage: label.isLivePostage,
  };
}

function labelFromPrintQueue(entry: MultiPackagePrintQueueSidecarEntry): MultiPackageReviewLabelFacts {
  return {
    source: 'print_queue_sidecar',
    shipmentId: entry.shipmentId,
    trackingNumber: entry.trackingNumber,
    labelUrl: entry.labelUrl,
    provider: entry.provider,
    serviceLabel: null,
    isLivePostage: entry.isLivePostage,
  };
}

function labelFromMarketplace(
  entry: MultiPackageMarketplaceConfirmationSidecarEntry,
): MultiPackageReviewLabelFacts {
  return {
    source: 'marketplace_confirmation_sidecar',
    shipmentId: entry.shipmentId,
    trackingNumber: entry.trackingNumber,
    labelUrl: entry.labelUrl,
    provider: entry.provider,
    serviceLabel: entry.serviceLabel,
    isLivePostage: entry.isLivePostage,
  };
}

function statusFor(row: {
  label: MultiPackageReviewLabelFacts | null;
  printQueue: MultiPackageReviewPackageRow['printQueue'];
  marketplaceConfirmation: MultiPackageReviewPackageRow['marketplaceConfirmation'];
}): MultiPackageReviewStatus {
  if (row.marketplaceConfirmation) return 'marketplace_confirmation_sidecar_planned';
  if (row.printQueue) return 'print_queue_sidecar_planned';
  if (row.label) return 'label_purchased';
  return 'planned';
}

function missingFor(row: {
  label: MultiPackageReviewLabelFacts | null;
  printQueue: MultiPackageReviewPackageRow['printQueue'];
  marketplaceConfirmation: MultiPackageReviewPackageRow['marketplaceConfirmation'];
}): string[] {
  const missing: string[] = [];
  if (!row.label) missing.push('label');
  if (!row.printQueue) missing.push('print_queue_sidecar');
  if (!row.marketplaceConfirmation) missing.push('marketplace_confirmation_sidecar');
  return missing;
}

export function buildMultiPackageReviewDto(
  plan: MultiPackageShipmentPlan,
  options: {
    labelFlow?: MultiPackageLabelPurchaseFlow | null;
    printQueueSidecarPlan?: MultiPackagePrintQueueSidecarPlan | null;
    marketplaceConfirmationSidecarPlan?: MultiPackageMarketplaceConfirmationSidecarPlan | null;
  } = {},
): MultiPackageReviewDto {
  const planKeys = planKeySet(plan);

  if (options.labelFlow) {
    assertGroupMatchesPlan('Label flow', plan, options.labelFlow.group);
  }
  if (options.printQueueSidecarPlan) {
    assertGroupMatchesPlan('Print queue sidecar plan', plan, options.printQueueSidecarPlan.group);
  }
  if (options.marketplaceConfirmationSidecarPlan) {
    assertGroupMatchesPlan(
      'Marketplace confirmation sidecar plan',
      plan,
      options.marketplaceConfirmationSidecarPlan.group,
    );
  }

  const labels = indexByPackageKey(
    'Label flow',
    planKeys,
    options.labelFlow?.labels ?? [],
    (row) => row.labelIdempotencyKey,
  );
  const printQueueEntries = indexByPackageKey(
    'Print queue sidecar plan',
    planKeys,
    options.printQueueSidecarPlan?.entries ?? [],
    (row) => row.labelIdempotencyKey,
  );
  const confirmations = indexByPackageKey(
    'Marketplace confirmation sidecar plan',
    planKeys,
    options.marketplaceConfirmationSidecarPlan?.confirmations ?? [],
    (row) => row.labelIdempotencyKey,
  );

  const packages = plan.packages.map((pkg): MultiPackageReviewPackageRow => {
    const labelEntry = labels.get(pkg.labelIdempotencyKey) ?? null;
    const printQueueEntry = printQueueEntries.get(pkg.labelIdempotencyKey) ?? null;
    const confirmationEntry = confirmations.get(pkg.labelIdempotencyKey) ?? null;
    const label =
      labelEntry ? labelFromPurchase(labelEntry) :
      printQueueEntry ? labelFromPrintQueue(printQueueEntry) :
      confirmationEntry ? labelFromMarketplace(confirmationEntry) :
      null;
    const printQueue = printQueueEntry
      ? {
          queueId: printQueueEntry.queueId,
          skuGroupId: printQueueEntry.skuGroupId,
          primarySku: printQueueEntry.primarySku,
          itemDescription: printQueueEntry.itemDescription,
          orderQty: printQueueEntry.orderQty,
          realPrintQueueInserted: printQueueEntry.realPrintQueueInserted,
        }
      : null;
    const marketplaceConfirmation = confirmationEntry
      ? {
          confirmationId: confirmationEntry.confirmationId,
          carrierName: confirmationEntry.carrierName,
          serviceLabel: confirmationEntry.serviceLabel,
          trackingNumber: confirmationEntry.trackingNumber,
          realMarketplaceNotificationSent: confirmationEntry.realMarketplaceNotificationSent,
        }
      : null;
    const missing = missingFor({ label, printQueue, marketplaceConfirmation });
    const status = statusFor({ label, printQueue, marketplaceConfirmation });

    return {
      packageKey: pkg.packageKey,
      packageSequence: pkg.packageSequence,
      labelIdempotencyKey: pkg.labelIdempotencyKey,
      status,
      weightOz: pkg.weightOz,
      dimensions: pkg.dimensions,
      items: pkg.items,
      label,
      printQueue,
      marketplaceConfirmation,
      missing,
      readyForOperatorReview: missing.length === 0 && label?.isLivePostage !== true,
    };
  });

  const livePostagePackageCount = packages.filter((row) => row.label?.isLivePostage === true).length;
  const readyForOperatorReviewCount = packages.filter((row) => row.readyForOperatorReview).length;

  return {
    group: {
      orderId: plan.orderId,
      orderNumber: plan.orderNumber,
      groupKey: plan.shipmentGroupKey,
      packageCount: plan.packageCount,
    },
    packages,
    summary: {
      totalPackages: packages.length,
      labelPackageCount: packages.filter((row) => row.label != null).length,
      printQueuePackageCount: packages.filter((row) => row.printQueue != null).length,
      marketplaceConfirmationPackageCount: packages.filter((row) => row.marketplaceConfirmation != null).length,
      readyForOperatorReviewCount,
      livePostagePackageCount,
      allPackagesReadyForOperatorReview: packages.length > 0 && readyForOperatorReviewCount === packages.length,
    },
    safety: {
      realPrintQueueInserted: false,
      realMarketplaceNotificationSent: false,
      hasLivePostage: livePostagePackageCount > 0,
    },
  };
}
