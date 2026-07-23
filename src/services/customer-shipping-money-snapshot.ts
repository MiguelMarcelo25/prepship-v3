import { roundMoney } from '../lib/money.js';

export const CUSTOMER_SHIPPING_MONEY_POLICY_VERSION = 'ps-437-v1';

export type FrozenCustomerShippingMoney = {
  selectedRateCost: number;
  cShippingRateAmount: number;
  shippingMarginAmount: number;
  shippingMarginPct: number | null;
  customerRateSource: 'realized_customer_shipping_rate' | 'hugrab_shipping_rate_override';
  rateCostSource: 'label_final_cost';
  customerShippingMoneyPolicyVersion: typeof CUSTOMER_SHIPPING_MONEY_POLICY_VERSION;
};

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Strict reader for an already-frozen shared money snapshot. Unlike the legacy
 * rate normalizer, this never manufactures customer money from selected cost.
 */
export function readFrozenCustomerShippingMoney(value: unknown): FrozenCustomerShippingMoney | null {
  const row = recordOrNull(value);
  if (!row) return null;
  const selectedRateCost = finiteNumber(row.selectedRateCost);
  const cShippingRateAmount = finiteNumber(row.cShippingRateAmount);
  const shippingMarginAmount = finiteNumber(row.shippingMarginAmount);
  const hasShippingMarginPct = Object.prototype.hasOwnProperty.call(row, 'shippingMarginPct');
  const shippingMarginPct = row.shippingMarginPct == null
    ? null
    : finiteNumber(row.shippingMarginPct);
  const customerRateSource = row.customerRateSource;
  const rateCostSource = row.rateCostSource;
  const policyVersion = row.customerShippingMoneyPolicyVersion;
  if (
    selectedRateCost == null || selectedRateCost <= 0 ||
    cShippingRateAmount == null || cShippingRateAmount <= 0 ||
    shippingMarginAmount == null ||
    !hasShippingMarginPct ||
    (row.shippingMarginPct != null && shippingMarginPct == null) ||
    Math.abs(roundMoney(cShippingRateAmount - selectedRateCost) - roundMoney(shippingMarginAmount)) > 0.001 ||
    (customerRateSource !== 'realized_customer_shipping_rate' && customerRateSource !== 'hugrab_shipping_rate_override') ||
    rateCostSource !== 'label_final_cost' ||
    policyVersion !== CUSTOMER_SHIPPING_MONEY_POLICY_VERSION
  ) {
    return null;
  }
  return {
    selectedRateCost: roundMoney(selectedRateCost),
    cShippingRateAmount: roundMoney(cShippingRateAmount),
    shippingMarginAmount: roundMoney(shippingMarginAmount),
    shippingMarginPct,
    customerRateSource,
    rateCostSource,
    customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  };
}
