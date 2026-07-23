import { normalizeShippingRateMoney } from './shipping-rate-money-normalizer.js';
import { roundMoney } from '../../lib/money.js';

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
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Number.isFinite(Number((value as { amount?: unknown }).amount))
    ? Number((value as { amount?: unknown }).amount)
    : 0;
}

function moneyObjectMaxAmount(primary: unknown, fallback: unknown): number {
  return Math.max(moneyObjectAmount(primary), moneyObjectAmount(fallback));
}

function rateOtherCostAmount(rate: RateRecord): number {
  const raw = asRecord(rate.raw) ?? {};
  const structuredOtherCost = roundMoney(
    moneyObjectMaxAmount(rate.other_amount, raw.other_amount) +
      moneyObjectMaxAmount(rate.confirmation_amount, raw.confirmation_amount) +
      moneyObjectMaxAmount(rate.insurance_amount, raw.insurance_amount),
  );
  const plainOtherCost = firstFiniteNumber(
    rate.otherCost,
    raw.otherCost,
    rate.other_cost,
    raw.other_cost,
  );
  return roundMoney(Math.max(0, structuredOtherCost, plainOtherCost ?? 0));
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
  const otherCost = rateOtherCostAmount(rate);
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
