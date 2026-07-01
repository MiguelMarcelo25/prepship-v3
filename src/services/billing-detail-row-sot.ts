import { resolveBillingBoxCostAlert } from './billing-box-cost-alert';

export type BillingDetailReadModelRow = Record<string, unknown>;

function numberValue(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? value : null;
}

function nonEmpty(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

function billingLineMetrics(row: BillingDetailReadModelRow) {
  const lineType = row.lineType ?? row.line_type;
  const lineTotal = numberValue(row.totalCost ?? row.total_cost);
  const pickPack = numberValue(
    row.pickpackTotal ??
      row.pick_pack_total ??
      (lineType === 'pick_pack' || lineType === 'pickpack' ? lineTotal : 0),
  );
  const additional = numberValue(
    row.additionalTotal ??
      row.additional_total ??
      (lineType === 'additional_unit' || lineType === 'additional' ? lineTotal : 0),
  );
  const packageCost = numberValue(
    row.packageTotal ??
      row.package_total ??
      (lineType === 'package_cost' ? lineTotal : 0),
  );
  const shipping = numberValue(
    row.shippingTotal ??
      row.shipping_total ??
      (lineType === 'shipping' ? lineTotal : 0),
  );
  const storage = numberValue(
    row.storageTotal ??
      row.storage_total ??
      (lineType === 'storage' ? lineTotal : 0),
  );
  const total = numberValue(row.grandTotal ?? row.grand_total ?? row.total) ||
    pickPack + additional + packageCost + shipping + storage;

  return { pickPack, additional, packageCost, shipping, storage, total };
}

function rowKey(row: BillingDetailReadModelRow): string {
  const orderId = row.orderId ?? row.order_id;
  if (nonEmpty(orderId)) return `order:${String(orderId)}`;
  return [
    'storage',
    String(row.description ?? ''),
    String(row.lineType ?? row.line_type ?? ''),
    String(row.id ?? ''),
  ].join(':');
}

function carryText(target: BillingDetailReadModelRow, source: BillingDetailReadModelRow, key: string): void {
  if (textValue(target[key])) return;
  const value = textValue(source[key]);
  if (value) target[key] = value;
}

function carryValue(target: BillingDetailReadModelRow, source: BillingDetailReadModelRow, key: string): void {
  if (nonEmpty(target[key])) return;
  if (nonEmpty(source[key])) target[key] = source[key];
}

function carryBooleanOr(target: BillingDetailReadModelRow, source: BillingDetailReadModelRow, key: string): void {
  target[key] = target[key] === true || source[key] === true;
}

const TEXT_CARRY_FIELDS = [
  'shipDate',
  'ship_date',
  'carrierCode',
  'carrier_code',
  'carrierNickname',
  'carrier_nickname',
  'providerAccountNickname',
  'provider_account_nickname',
  'itemNames',
  'item_names',
  'itemSkus',
  'item_skus',
  'packageName',
  'package_name',
  'packageCostReviewReason',
  'package_cost_review_reason',
] as const;

const VALUE_CARRY_FIELDS = [
  'shipmentId',
  'shipment_id',
  'packageId',
  'package_id',
  'providerAccountId',
  'provider_account_id',
  'labelProvider',
  'label_provider',
  'trackingNumber',
  'tracking_number',
  'totalQty',
  'total_qty',
  'selectedRateCost',
  'selected_rate_cost',
  'actualLabelCost',
  'actual_label_cost',
  'refUpsRate',
  'ref_ups_rate',
  'refUspsRate',
  'ref_usps_rate',
  'feeWaiverDecision',
  'fee_waiver_decision',
  'billingBadges',
  'billing_badges',
] as const;

const BOOLEAN_OR_FIELDS = [
  'hasPackageCostLine',
  'has_package_cost_line',
  'boxCostNoCharge',
  'box_cost_no_charge',
  'boxCostAlert',
  'box_cost_alert',
  'stalePackagePrice',
  'stale_package_price',
  'packageCostNeedsReview',
  'package_cost_needs_review',
  'shippingZeroNeedsReview',
  'shipping_zero_needs_review',
  'feeWaived',
  'fee_waived',
] as const;

function applyBoxCostAlert(row: BillingDetailReadModelRow): void {
  const result = resolveBillingBoxCostAlert({
    packageCost: row.packageTotal ?? row.package_total,
    hasPackageCostLine: row.hasPackageCostLine === true || row.has_package_cost_line === true,
    packageCostNeedsReview: row.packageCostNeedsReview === true || row.package_cost_needs_review === true,
    isNoChargeBoxCostLine: row.boxCostNoCharge === true || row.box_cost_no_charge === true,
    canAlertMissing: nonEmpty(row.orderId ?? row.order_id),
    existingBadges: row.billingBadges ?? row.billing_badges,
  });
  row.boxCostAlert = result.boxCostAlert;
  row.box_cost_alert = result.boxCostAlert;
  row.billingBadges = result.billingBadges;
  row.billing_badges = result.billingBadges;
}

export function toBillingDetailOrderRows(rows: BillingDetailReadModelRow[]): BillingDetailReadModelRow[] {
  const byKey = new Map<string, BillingDetailReadModelRow>();
  const order: string[] = [];

  for (const row of rows) {
    const key = rowKey(row);
    const metrics = billingLineMetrics(row);
    const lineType = row.lineType ?? row.line_type;
    const hasPackageCostLine =
      lineType === 'package_cost' ||
      row.hasPackageCostLine === true ||
      row.has_package_cost_line === true;
    const boxCostNoCharge =
      row.boxCostNoCharge === true ||
      row.box_cost_no_charge === true;
    const existing = byKey.get(key);

    if (!existing) {
      const next: BillingDetailReadModelRow = {
        ...row,
        lineType: 'billing_order',
        line_type: 'billing_order',
        pickpackTotal: metrics.pickPack,
        pick_pack_total: metrics.pickPack,
        additionalTotal: metrics.additional,
        additional_total: metrics.additional,
        packageTotal: metrics.packageCost,
        package_total: metrics.packageCost,
        shippingTotal: metrics.shipping,
        shipping_total: metrics.shipping,
        storageTotal: metrics.storage,
        storage_total: metrics.storage,
        pickPackFeeTotal: metrics.pickPack + metrics.additional,
        pick_pack_fee_total: metrics.pickPack + metrics.additional,
        fulfillmentFeeTotal: metrics.pickPack + metrics.additional + metrics.packageCost + metrics.shipping + metrics.storage,
        fulfillment_fee_total: metrics.pickPack + metrics.additional + metrics.packageCost + metrics.shipping + metrics.storage,
        grandTotal: metrics.total,
        grand_total: metrics.total,
        totalCost: 0,
        total_cost: 0,
        hasPackageCostLine,
        has_package_cost_line: hasPackageCostLine,
        boxCostNoCharge,
        box_cost_no_charge: boxCostNoCharge,
      };
      applyBoxCostAlert(next);
      byKey.set(key, next);
      order.push(key);
      continue;
    }

    existing.pickpackTotal = numberValue(existing.pickpackTotal) + metrics.pickPack;
    existing.pick_pack_total = existing.pickpackTotal;
    existing.additionalTotal = numberValue(existing.additionalTotal) + metrics.additional;
    existing.additional_total = existing.additionalTotal;
    existing.packageTotal = numberValue(existing.packageTotal) + metrics.packageCost;
    existing.package_total = existing.packageTotal;
    existing.shippingTotal = numberValue(existing.shippingTotal) + metrics.shipping;
    existing.shipping_total = existing.shippingTotal;
    existing.storageTotal = numberValue(existing.storageTotal) + metrics.storage;
    existing.storage_total = existing.storageTotal;
    existing.pickPackFeeTotal = numberValue(existing.pickpackTotal) + numberValue(existing.additionalTotal);
    existing.pick_pack_fee_total = existing.pickPackFeeTotal;
    existing.fulfillmentFeeTotal =
      numberValue(existing.pickpackTotal) +
      numberValue(existing.additionalTotal) +
      numberValue(existing.packageTotal) +
      numberValue(existing.shippingTotal) +
      numberValue(existing.storageTotal);
    existing.fulfillment_fee_total = existing.fulfillmentFeeTotal;
    existing.grandTotal = numberValue(existing.grandTotal) + metrics.total;
    existing.grand_total = existing.grandTotal;
    existing.hasPackageCostLine = existing.hasPackageCostLine === true || hasPackageCostLine;
    existing.has_package_cost_line = existing.hasPackageCostLine;
    existing.boxCostNoCharge = existing.boxCostNoCharge === true || boxCostNoCharge;
    existing.box_cost_no_charge = existing.boxCostNoCharge;

    for (const field of TEXT_CARRY_FIELDS) carryText(existing, row, field);
    for (const field of VALUE_CARRY_FIELDS) carryValue(existing, row, field);
    for (const field of BOOLEAN_OR_FIELDS) carryBooleanOr(existing, row, field);
    applyBoxCostAlert(existing);
  }

  return order.map((key) => byKey.get(key)!);
}
