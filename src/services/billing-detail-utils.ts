export type BillingItemSummary = {
  itemNames: string | null;
  itemSkus: string | null;
  totalQty: number | null;
};

type BillingItemGroup = {
  key: string;
  name: string | null;
  sku: string | null;
  qty: number;
};

const QTY_SUFFIX_MULTIPLY = '\u00d7';

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function itemSkuOrFallback(record: Record<string, unknown>): string | null {
  const sku =
    stringOrNull(record.sku) ??
    stringOrNull(record.skuAlias) ??
    stringOrNull(record.fulfillmentSku) ??
    stringOrNull(record.warehouseLocation);
  if (sku) return sku;

  const productId = toFiniteNumber(record.productId);
  return productId != null ? String(Math.trunc(productId)) : null;
}

function formatQtyLabel(value: string, qty: number): string {
  return qty > 1 ? `${value} ${QTY_SUFFIX_MULTIPLY}${qty}` : value;
}

export function summarizeBillingItemsForDetail(items: unknown): BillingItemSummary {
  if (!Array.isArray(items)) {
    return { itemNames: null, itemSkus: null, totalQty: null };
  }

  const groups: BillingItemGroup[] = [];
  const groupByKey = new Map<string, BillingItemGroup>();
  let totalQty = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.adjustment === true) continue;

    const name = stringOrNull(record.name);
    const sku = itemSkuOrFallback(record);
    const qty = toFiniteNumber(record.quantity) ?? 1;
    if (qty <= 0) continue;

    const identity = sku ?? name;
    if (!identity) {
      totalQty += qty;
      continue;
    }

    const key = `${sku ? 'sku' : 'name'}:${identity.trim().toLowerCase()}`;
    let group = groupByKey.get(key);
    if (!group) {
      group = { key, name, sku, qty: 0 };
      groupByKey.set(key, group);
      groups.push(group);
    } else {
      group.name = group.name ?? name;
      group.sku = group.sku ?? sku;
    }
    group.qty += qty;
    totalQty += qty;
  }

  return {
    itemNames: groups
      .filter((group) => group.name)
      .map((group) => formatQtyLabel(group.name!, group.qty))
      .join(' | ') || null,
    itemSkus: groups
      .filter((group) => group.sku)
      .map((group) => formatQtyLabel(group.sku!, group.qty))
      .join(' | ') || null,
    totalQty: totalQty > 0 ? totalQty : null,
  };
}

export type BillingShipmentRepairCandidate = {
  billingLineItemId: number;
  orderId: number | null;
  orderNumber: string | null;
  lineType: string;
  description: string;
  currentShipmentId: number | null;
  matchingShipmentId: number | null;
  carrierCode: string | null;
  cost: string | null;
  dimsL: number | null;
  dimsW: number | null;
  dimsH: number | null;
  lineHasManualInvoiceLock: boolean;
};

export type BillingShipmentRepairAction = {
  action: 'update_shipment_id';
  billingLineItemId: number;
  orderId: number | null;
  orderNumber: string | null;
  lineType: string;
  description: string;
  currentShipmentId: number | null;
  matchingShipmentId: number;
  carrierCode: string | null;
  cost: string | null;
  dims: string | null;
  requiresApproval: boolean;
};

export type BillingShipmentRepairPlan = {
  scanned: number;
  alreadyLinked: number;
  missingShipment: number;
  ambiguousOrLocked: number;
  actions: BillingShipmentRepairAction[];
};

function dimsLabel(length: number | null, width: number | null, height: number | null): string | null {
  if (length == null || width == null || height == null) return null;
  return `${length}x${width}x${height}`;
}

export function buildBillingShipmentRepairPlan(
  candidates: BillingShipmentRepairCandidate[],
): BillingShipmentRepairPlan {
  const plan: BillingShipmentRepairPlan = {
    scanned: candidates.length,
    alreadyLinked: 0,
    missingShipment: 0,
    ambiguousOrLocked: 0,
    actions: [],
  };

  for (const candidate of candidates) {
    if (candidate.currentShipmentId != null) {
      plan.alreadyLinked += 1;
      continue;
    }
    if (candidate.matchingShipmentId == null) {
      plan.missingShipment += 1;
      continue;
    }
    if (candidate.lineHasManualInvoiceLock) {
      plan.ambiguousOrLocked += 1;
      continue;
    }
    plan.actions.push({
      action: 'update_shipment_id',
      billingLineItemId: candidate.billingLineItemId,
      orderId: candidate.orderId,
      orderNumber: candidate.orderNumber,
      lineType: candidate.lineType,
      description: candidate.description,
      currentShipmentId: candidate.currentShipmentId,
      matchingShipmentId: candidate.matchingShipmentId,
      carrierCode: candidate.carrierCode,
      cost: candidate.cost,
      dims: dimsLabel(candidate.dimsL, candidate.dimsW, candidate.dimsH),
      requiresApproval: true,
    });
  }

  return plan;
}
