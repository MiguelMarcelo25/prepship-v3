// PS-293 / PS-220 / PS-333: the ONE owner that stamps the house margin tuple
// (nextBestNonHouseRate + houseMargin) onto a finalized best rate.
//
// /rates/browse and rates-backfill both call this owner so the persisted best
// rate has the same customer-rate tuple no matter which surface rated the row.
// Provider identity is not the house divider; policy mode is the default-off
// gate, and the customer-rate ladder is resolved from current eligible rates.

import { rateCostTotal, rateTotal, type CombinableRate } from '../rates-combined.js';
import { resolveNextBestNonHouseRate } from '../../lib/next-best-non-house-rate.js';
import { shippingMarginPolicyForClient } from '../house-account-opt-in.js';
import { loadShippingAutomationRules } from '../shipping-automation.js';
import { roundMoney } from '../../lib/money.js';

export async function stampHouseTuple(
  bestRate: Record<string, unknown>,
  input: {
    cheapest: CombinableRate;
    combinedRates: CombinableRate[];
    clientId: unknown;
    storeId: unknown;
    insuranceProvider?: string | null;
    insuredValue?: number | null;
  },
): Promise<Record<string, unknown>> {
  try {
    const houseClientId = typeof input.clientId === 'number' ? input.clientId : null;
    const shippingMarginPolicy = await shippingMarginPolicyForClient(houseClientId);
    if (shippingMarginPolicy.mode !== 'next_best_customer_rate') return bestRate;
    const houseStoreId = typeof input.storeId === 'number' ? input.storeId : null;
    const houseAutomationRules = await loadShippingAutomationRules().catch(() => null);
    const nextBest = resolveNextBestNonHouseRate({
      eligibleRates: input.combinedRates,
      context: { clientId: houseClientId, storeId: houseStoreId },
      shippingOptions: {
        insuranceProvider: input.insuranceProvider ?? null,
        insuredValue: input.insuredValue ?? null,
      },
      automationRules: houseAutomationRules,
      client: { houseAccountOptIn: shippingMarginPolicy.legacyHouseAccountEnabled, shippingMarginPolicy },
    });
    const drpCost = roundMoney(rateCostTotal(input.cheapest));
    const customerRate = roundMoney(nextBest ? nextBest.total : drpCost);
    const houseMargin = roundMoney(nextBest ? Math.max(0, customerRate - drpCost) : 0);
    const shippingMarginPct =
      houseMargin >= 0.005 && customerRate > 0 ? Math.round((houseMargin / customerRate) * 1000) / 10 : null;
    const providerMatch = nextBest ? /^se-(\d+)$/i.exec(String(nextBest.rate.carrier_id ?? '')) : null;
    return {
      ...bestRate,
      nextBestNonHouseRate: nextBest
        ? {
            carrierCode: String(nextBest.rate.carrier_code ?? '') || null,
            serviceCode: String(nextBest.rate.service_code ?? '') || null,
            shipmentCost: Number(nextBest.rate.shipping_amount?.amount ?? nextBest.total),
            otherCost: Number(nextBest.rate.other_amount?.amount ?? 0),
            totalCost: nextBest.total,
            providerAccountId: providerMatch ? Number.parseInt(providerMatch[1]!, 10) : null,
            competitorCount: nextBest.competitorCount,
        }
        : null,
      houseMargin,
      cShippingRateAmount: customerRate,
      selectedRateCost: drpCost,
      shippingMarginAmount: houseMargin,
      shipping_margin_amount: houseMargin,
      shippingMarginPct,
      shipping_margin_pct: shippingMarginPct,
      houseApplied: true,
      houseBadgeVisible: true,
      customerRateSource: 'projected_customer_shipping_rate',
      rateCostSource: 'shipp_house_internal_cost',
    };
  } catch (err) {
    console.warn('[house-tuple-stamp] projection skipped:', err instanceof Error ? err.message : err);
    return bestRate;
  }
}
