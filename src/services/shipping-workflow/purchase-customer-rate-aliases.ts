import { rateCostTotal, rateTotal, type CombinableRate } from '../rates-combined.js';

type RateRecord = Record<string, unknown>;

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
  const amount = finiteNumber(record?.amount);
  return amount ?? 0;
}

function roundMoney(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function amountLooksLikeTotal(amount: number, componentTotal: number): boolean {
  return amount >= componentTotal - 0.005;
}

function amountLooksLikeCamelTotal(rate: RateRecord, amount: number): boolean {
  const shipmentCost = firstFiniteNumber(rate.shipmentCost, rate.shipment_cost);
  const otherCost = firstFiniteNumber(rate.otherCost, rate.other_cost);
  if (shipmentCost == null || otherCost == null) return false;
  return amountLooksLikeTotal(amount, shipmentCost + otherCost);
}

function sourceSaysTotal(value: unknown): boolean {
  return typeof value === 'string' && (
    value === 'projected_house_customer_rate' ||
    value === 'realized_house_customer_rate' ||
    value === 'best_rate_internal_cost' ||
    value === 'selected_rate_internal_cost' ||
    value === 'label_final_cost' ||
    value === 'shipp_house_internal_cost'
  );
}

export function buildPurchaseCustomerRateMoney(rate: RateRecord): {
  otherCost: number;
  purchaseTotal: number;
  purchaseShipmentCost: number;
  customerTotal: number;
  shippingMarginAmount: number;
  shippingMarginPct: number | null;
} {
  const otherCost = roundMoney(
    moneyObjectAmount(rate.other_amount) +
      moneyObjectAmount(rate.confirmation_amount) +
      moneyObjectAmount(rate.insurance_amount),
  );
  const purchaseComponentTotal = roundMoney(rateCostTotal(rate as CombinableRate));
  const customerComponentTotal = roundMoney(rateTotal(rate as CombinableRate));

  const explicitRateCost = firstFiniteNumber(rate.rateCostAmount, rate.rate_cost_amount);
  const purchaseTotal = roundMoney(
    explicitRateCost == null
      ? purchaseComponentTotal
      : sourceSaysTotal(rate.rateCostSource ?? rate.rate_cost_source) ||
          amountLooksLikeTotal(explicitRateCost, purchaseComponentTotal) ||
          amountLooksLikeCamelTotal(rate, explicitRateCost)
        ? explicitRateCost
        : explicitRateCost + otherCost,
  );

  const explicitCustomer = firstFiniteNumber(rate.customerRateAmount, rate.customer_rate_amount);
  const customerTotal = roundMoney(
    explicitCustomer == null
      ? customerComponentTotal
      : sourceSaysTotal(rate.customerRateSource ?? rate.customer_rate_source) ||
          amountLooksLikeTotal(explicitCustomer, customerComponentTotal) ||
          amountLooksLikeCamelTotal(rate, explicitCustomer)
        ? explicitCustomer
        : explicitCustomer + otherCost,
  );

  const shippingMarginAmount = roundMoney(Math.max(0, customerTotal - purchaseTotal));
  return {
    otherCost,
    purchaseTotal,
    purchaseShipmentCost: roundMoney(Math.max(0, purchaseTotal - otherCost)),
    customerTotal,
    shippingMarginAmount,
    shippingMarginPct:
      shippingMarginAmount >= 0.005 && customerTotal > 0
        ? Math.round((shippingMarginAmount / customerTotal) * 1000) / 10
        : null,
  };
}

export function stampPurchaseCustomerRateAliases<T extends RateRecord>(rate: T): T & {
  amount: number;
  shipmentCost: number;
  otherCost: number;
  totalCost: number;
  total_cost: number;
  customerRateAmount: number;
  customer_rate_amount: number;
  rateCostAmount: number;
  rate_cost_amount: number;
  shippingMarginAmount: number;
  shipping_margin_amount: number;
  shippingMarginPct: number | null;
  shipping_margin_pct: number | null;
} {
  const money = buildPurchaseCustomerRateMoney(rate);
  return {
    ...rate,
    amount: money.purchaseTotal,
    shipmentCost: money.purchaseShipmentCost,
    otherCost: money.otherCost,
    totalCost: money.purchaseTotal,
    total_cost: money.purchaseTotal,
    customerRateAmount: money.customerTotal,
    customer_rate_amount: money.customerTotal,
    rateCostAmount: money.purchaseTotal,
    rate_cost_amount: money.purchaseTotal,
    shippingMarginAmount: money.shippingMarginAmount,
    shipping_margin_amount: money.shippingMarginAmount,
    shippingMarginPct: money.shippingMarginPct,
    shipping_margin_pct: money.shippingMarginPct,
  };
}
