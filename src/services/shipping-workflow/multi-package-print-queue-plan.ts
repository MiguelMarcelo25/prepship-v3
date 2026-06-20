/**
 * PS-289 - pure group-aware print queue planning.
 *
 * Converts mocked multi-package labels into queue candidates only.
 * No real print queue writes, provider calls, postage, marketplace, or shipped/cancelled mutation happens here.
 */
import type {
  MockedMultiPackageLabel,
  MockedMultiPackageLabelFlow,
} from './multi-package-mock-label-flow';

export type MultiPackagePrintQueueEntryCandidate = {
  queueId: string;
  orderId: number;
  clientId: number | null;
  orderNumber: string | null;
  shipmentGroupKey: string;
  packageKey: string;
  packageSequence: number;
  labelIdempotencyKey: string;
  labelUrl: string;
  trackingNumber: string;
  skuGroupId: string;
  primarySku: string | null;
  itemDescription: string;
  orderQty: number;
  status: 'planned';
  provider: 'mock_multi_package';
  isLivePostage: false;
  marketplaceConfirmationPlanned: false;
};

export type MultiPackagePrintQueuePlan = {
  group: {
    orderId: number;
    clientId: number | null;
    groupKey: string;
    status: 'print_queue_planned';
    packageCount: number;
  };
  entries: MultiPackagePrintQueueEntryCandidate[];
};

function quantity(value: number | null): number {
  return Number.isFinite(value) && value != null && value > 0 ? value : 1;
}

function summarizeItems(label: MockedMultiPackageLabel): {
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
  const itemDescription = items
    .map((item) => `${item.sku} x${quantity(item.quantity)}`)
    .join(', ');
  return { primarySku, itemDescription, orderQty };
}

export function buildMultiPackagePrintQueuePlan(
  flow: MockedMultiPackageLabelFlow,
  options: {
    orderNumber?: string | number | null;
    existingQueuedLabelIdempotencyKeys?: string[];
  } = {},
): MultiPackagePrintQueuePlan {
  const existing = new Set(options.existingQueuedLabelIdempotencyKeys ?? []);
  const orderNumber = options.orderNumber == null ? null : String(options.orderNumber).trim() || null;
  const entries = flow.labels.map((label) => {
    if (existing.has(label.labelIdempotencyKey)) {
      throw new Error(`Package ${label.packageKey} already has a print queue candidate: ${label.labelIdempotencyKey}`);
    }
    const summary = summarizeItems(label);
    return {
      queueId: `mpq:${label.labelIdempotencyKey}`,
      orderId: label.orderId,
      clientId: label.clientId,
      orderNumber,
      shipmentGroupKey: flow.group.groupKey,
      packageKey: label.packageKey,
      packageSequence: label.packageSequence,
      labelIdempotencyKey: label.labelIdempotencyKey,
      labelUrl: label.labelUrl,
      trackingNumber: label.trackingNumber,
      skuGroupId: `multi-package:${label.packageKey}`,
      primarySku: summary.primarySku,
      itemDescription: summary.itemDescription,
      orderQty: summary.orderQty,
      status: 'planned',
      provider: 'mock_multi_package',
      isLivePostage: false,
      marketplaceConfirmationPlanned: false,
    } satisfies MultiPackagePrintQueueEntryCandidate;
  });

  return {
    group: {
      orderId: flow.group.orderId,
      clientId: flow.group.clientId,
      groupKey: flow.group.groupKey,
      status: 'print_queue_planned',
      packageCount: flow.group.packageCount,
    },
    entries,
  };
}
