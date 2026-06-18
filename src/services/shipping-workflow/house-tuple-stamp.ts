// PS-293 / PS-220 — the ONE owner that stamps the SHIPP house-account tuple (nextBestNonHouseRate +
// houseMargin) onto a finalized best rate.
//
// WHY: /rates/browse stamped this tuple inline, but the rates-backfill job (Recalculate All AND the
// PS-293 Awaiting passive-overflow handoff) did NOT — so a HUGRAB house order rated by the backend
// backfill got a tuple-LESS best rate, while the same order via Rate Browser got the tuple. That is the
// PS-293 "two competing rate truths" bug: which surface rated the row decided whether the House tuple
// appeared. Both paths now call this single owner, so the persisted best rate is identical either way.
//
// DEFAULT-OFF INERT: clientHouseAccountEnabled is false unless a client opted in (PS-220 default-OFF),
// so for every non-opted-in client this returns the best rate UNCHANGED — byte-identical to today.
// Best-effort: any failure logs and returns the input unchanged (never breaks rating).

import { rateTotal, type CombinableRate } from '../rates-combined.js';
import { isHouseShippRate, resolveNextBestNonHouseRate } from '../../lib/next-best-non-house-rate.js';
import { clientHouseAccountEnabled } from '../house-account-opt-in.js';
import { loadShippingAutomationRules } from '../shipping-automation.js';

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
  // SHIPP identity is provider-only (the carrier_code trap) — handled by isHouseShippRate.
  if (!isHouseShippRate(input.cheapest)) return bestRate;
  try {
    const houseClientId = typeof input.clientId === 'number' ? input.clientId : null;
    if (!(await clientHouseAccountEnabled(houseClientId))) return bestRate;
    const houseStoreId = typeof input.storeId === 'number' ? input.storeId : null;
    // Same eligibility basis the customer faces (admin-disabled services + insurance-incapable carriers
    // excluded) so customer_rate is a rate the client could actually use. Best-effort automation load.
    const houseAutomationRules = await loadShippingAutomationRules().catch(() => null);
    const nextBest = resolveNextBestNonHouseRate({
      eligibleRates: input.combinedRates,
      context: { clientId: houseClientId, storeId: houseStoreId },
      shippingOptions: {
        insuranceProvider: input.insuranceProvider ?? null,
        insuredValue: input.insuredValue ?? null,
      },
      automationRules: houseAutomationRules,
      client: { houseAccountOptIn: true },
    });
    const drpCost = rateTotal(input.cheapest);
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
            // PS-220-D: the REAL eligible-priced-non-SHIPP competitor count.
            competitorCount: nextBest.competitorCount,
          }
        : null,
      houseMargin: nextBest ? Math.max(0, nextBest.total - drpCost) : 0,
    };
  } catch (err) {
    console.warn('[house-tuple-stamp] projection skipped:', err instanceof Error ? err.message : err);
    return bestRate;
  }
}
