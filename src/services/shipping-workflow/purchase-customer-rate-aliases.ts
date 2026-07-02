import { normalizeShippingRateMoney } from './shipping-rate-money-normalizer.js';

type RateRecord = Record<string, unknown>;

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function moneyObjectAmount(value: unknown): number {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Number.isFinite(Number((value as { amount?: unknown }).amount))
    ? Number((value as { amount?: unknown }).amount)
    : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildPurchaseCustomerRateMoney(rate: RateRecord): {
  otherCost: number;
  purchaseTotal: number;
  purchaseShipmentCost: number;
  customerTotal: number;
  shippingMarginAmount: number;
  shippingMarginPct: number | null;
} {
  const money = normalizeShippingRateMoney(rate);
  const otherCost = roundMoney(
    moneyObjectAmount(rate.other_amount) +
      moneyObjectAmount(rate.confirmation_amount) +
      moneyObjectAmount(rate.insurance_amount),
  );
  const purchaseTotal = money.selectedRateCost ?? 0;
  const customerTotal = money.cShippingRateAmount ?? purchaseTotal;
  return {
    otherCost,
    purchaseTotal,
    purchaseShipmentCost: roundMoney(Math.max(0, purchaseTotal - otherCost)),
    customerTotal,
    shippingMarginAmount: money.shippingMarginAmount ?? roundMoney(customerTotal - purchaseTotal),
    shippingMarginPct: money.shippingMarginPct,
  };
}

export function stampPurchaseCustomerRateAliases<T extends RateRecord>(rate: T): T & {
  amount: number;
  shipmentCost: number;
  otherCost: number;
  totalCost: number;
  total_cost: number;
  cShippingRateAmount: number;
  selectedRateCost: number;
  shippingMarginAmount: number;
  shipping_margin_amount: number;
  shippingMarginPct: number | null;
  shipping_margin_pct: number | null;
} {
  const money = buildPurchaseCustomerRateMoney(rate);
  const cShippingRateAmount = finiteNumber(rate.cShippingRateAmount) ?? money.customerTotal;
  const selectedRateCost = finiteNumber(rate.selectedRateCost) ?? money.purchaseTotal;
  const shippingMarginAmount = roundMoney(cShippingRateAmount - selectedRateCost);
  return {
    ...rate,
    amount: selectedRateCost,
    shipmentCost: money.purchaseShipmentCost,
    otherCost: money.otherCost,
    totalCost: selectedRateCost,
    total_cost: selectedRateCost,
    cShippingRateAmount,
    selectedRateCost,
    shippingMarginAmount,
    shipping_margin_amount: shippingMarginAmount,
    shippingMarginPct: money.shippingMarginPct,
    shipping_margin_pct: money.shippingMarginPct,
  };
}
