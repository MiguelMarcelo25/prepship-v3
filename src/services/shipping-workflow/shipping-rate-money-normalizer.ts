type RateRecord = Record<string, unknown>;

export type ShippingRateMoney = {
  cShippingRateAmount: number | null;
  selectedRateCost: number | null;
  shippingMarginAmount: number | null;
  shippingMarginPct: number | null;
};

export const CANONICAL_SHIPPING_RATE_MONEY_KEYS = [
  'cShippingRateAmount',
  'selectedRateCost',
  'shippingMarginAmount',
  'shippingMarginPct',
] as const;

export const LEGACY_SHIPPING_RATE_MONEY_KEYS = [
  'customerShippingRateAmount',
  'customer_shipping_rate_amount',
  'customerRateAmount',
  'customer_rate_amount',
  'houseCustomerRate',
  'house_customer_rate',
  'houseRateAmount',
  'house_rate_amount',
  'rateCostAmount',
  'rate_cost_amount',
] as const;

function asRecord(value: unknown): RateRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RateRecord
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const amount = finiteNumber(value);
    if (amount != null) return amount;
  }
  return null;
}

function moneyObjectAmount(value: unknown): number {
  const record = asRecord(value);
  return finiteNumber(record?.amount) ?? 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPercent(value: number): number {
  return Math.round(value * 1000) / 10;
}

function sourceSaysTotal(value: unknown): boolean {
  return typeof value === 'string' && (
    value === 'projected_customer_shipping_rate' ||
    value === 'realized_customer_shipping_rate' ||
    value === 'projected_house_customer_rate' ||
    value === 'realized_house_customer_rate' ||
    value === 'best_rate_internal_cost' ||
    value === 'selected_rate_internal_cost' ||
    value === 'label_final_cost' ||
    value === 'shipp_house_internal_cost' ||
    value === 'carrier_true_cost_uplift' ||
    value === 'true_cost_uplift'
  );
}

function amountLooksLikeTotal(amount: number, componentTotal: number): boolean {
  return amount >= componentTotal - 0.005;
}

function normalizeExplicitTotal(
  amount: number | null,
  componentTotal: number,
  otherCost: number,
  source: unknown,
): number | null {
  if (amount == null) return null;
  if (sourceSaysTotal(source) || amountLooksLikeTotal(amount, componentTotal)) return roundMoney(amount);
  return roundMoney(amount + otherCost);
}

export function normalizeShippingRateMoney(value: unknown): ShippingRateMoney {
  const rate = asRecord(value) ?? {};
  const raw = asRecord(rate.raw) ?? {};
  const otherCost = roundMoney(
    moneyObjectAmount(rate.other_amount ?? raw.other_amount) +
      moneyObjectAmount(rate.confirmation_amount ?? raw.confirmation_amount) +
      moneyObjectAmount(rate.insurance_amount ?? raw.insurance_amount),
  );
  const shippingComponent = firstFiniteNumber(
    rate.shipmentCost,
    raw.shipmentCost,
    rate.shipment_cost,
    raw.shipment_cost,
    asRecord(rate.shipping_amount)?.amount,
    asRecord(raw.shipping_amount)?.amount,
    rate.cost,
    raw.cost,
    rate.amount,
    raw.amount,
  );
  const componentTotal = roundMoney((shippingComponent ?? 0) + otherCost);

  const explicitSelected = firstFiniteNumber(
    rate.selectedRateCost,
    raw.selectedRateCost,
    rate.selected_rate_cost,
    raw.selected_rate_cost,
    rate.selectedRateCostAmount,
    raw.selectedRateCostAmount,
    rate.selected_rate_cost_amount,
    raw.selected_rate_cost_amount,
    rate.rateCostAmount,
    raw.rateCostAmount,
    rate.rate_cost_amount,
    raw.rate_cost_amount,
    rate.actualLabelCost,
    raw.actualLabelCost,
    rate.actual_label_cost,
    raw.actual_label_cost,
    rate.rawShippingAmount,
    raw.rawShippingAmount,
    rate.raw_shipping_amount,
    raw.raw_shipping_amount,
    rate.internalShippingAmount,
    raw.internalShippingAmount,
    rate.internal_shipping_amount,
    raw.internal_shipping_amount,
  );
  const selectedRateCost =
    normalizeExplicitTotal(explicitSelected, componentTotal, otherCost, rate.rateCostSource ?? rate.rate_cost_source) ??
    (componentTotal > 0 ? componentTotal : null);

  const explicitCShipping = firstFiniteNumber(
    rate.cShippingRateAmount,
    raw.cShippingRateAmount,
    rate.c_shipping_rate_amount,
    raw.c_shipping_rate_amount,
    rate.customerShippingRateAmount,
    raw.customerShippingRateAmount,
    rate.customer_shipping_rate_amount,
    raw.customer_shipping_rate_amount,
    rate.customerRateAmount,
    raw.customerRateAmount,
    rate.customer_rate_amount,
    raw.customer_rate_amount,
    rate.customerShippingAmount,
    raw.customerShippingAmount,
    rate.customer_shipping_amount,
    raw.customer_shipping_amount,
    rate.customerChargeAmount,
    raw.customerChargeAmount,
    rate.customer_charge_amount,
    raw.customer_charge_amount,
    rate.markedShippingAmount,
    raw.markedShippingAmount,
    rate.marked_shipping_amount,
    raw.marked_shipping_amount,
    rate.billableShippingAmount,
    raw.billableShippingAmount,
    rate.billable_shipping_amount,
    raw.billable_shipping_amount,
  );
  const cShippingRateAmount =
    normalizeExplicitTotal(explicitCShipping, componentTotal, otherCost, rate.customerRateSource ?? rate.customer_rate_source) ??
    selectedRateCost;

  const shippingMarginAmount =
    cShippingRateAmount != null && selectedRateCost != null
      ? roundMoney(cShippingRateAmount - selectedRateCost)
      : null;

  return {
    cShippingRateAmount,
    selectedRateCost,
    shippingMarginAmount,
    shippingMarginPct:
      shippingMarginAmount != null && Math.abs(shippingMarginAmount) >= 0.005 && cShippingRateAmount != null && cShippingRateAmount > 0
        ? roundPercent(shippingMarginAmount / cShippingRateAmount)
        : null,
  };
}
