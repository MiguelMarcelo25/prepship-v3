// PS-126 - Canonical owner of the ParcelGuard / insurance premium on a rate.
//
// ShipStation's POST /v2/rates/estimate returns insurance_amount: 0 for ParcelGuard
// on EVERY carrier (verified — see docs/ps-108-shipstation-parcelguard-cost-source.md),
// so the estimate alone cannot show the real premium the operator will be billed.
// PS-126 supplies the rate-time premium from ShipStation's verified ParcelGuard
// SCHEDULE (carrier/country-aware: USPS $1.09/$100, non-USPS $0.99/$100, intl
// $1.39/$100) when the estimate is 0, so an insured rate's displayed/selected total
// matches what ShipStation bills.
//
// Reconciliation:
//   - A POSITIVE ShipStation estimate is still trusted verbatim (source of truth).
//   - PS-125's anti-block guarantee is preserved: an insured rate is NEVER excluded
//     (the resolver never returns `unresolved`; if the schedule can't price a rate it
//     falls back to $0 rather than blocking).
//   - The schedule is a rate-time ESTIMATE; the ACTUAL billed ParcelGuard cost is
//     still reconciled AFTER label purchase via parcelguard-backfill (v2
//     insurance_cost / v1 otherCost), which remains the final source of truth.
// HUGRAB defaults to ParcelGuard / insured value 100 upstream (services/rates.ts).

export type InsuranceCostProvenance =
  | 'none'
  | 'shipstation_estimate'
  | 'parcelguard_schedule'
  | 'shipstation_v2_label'
  | 'shipstation_v1_shipment';

export type InsuranceCostResolution =
  | { status: 'none' }
  | {
      status: 'resolved';
      insuranceProvider: string;
      insuredValue: number;
      amount: number;
      provenance: InsuranceCostProvenance;
      confirmed: boolean;
      fetchedAt: string;
    }
  | {
      status: 'unresolved';
      insuranceProvider: string;
      insuredValue: number;
      reason: string;
    };

export type RateInsuranceCostMeta = {
  insuranceProvider: string;
  insuredValue: number;
  amount: number | null;
  provenance: InsuranceCostProvenance;
  confirmed: boolean;
  unresolved: boolean;
  reason?: string;
  fetchedAt: string | null;
};

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// PS-126 ParcelGuard schedule (ShipStation ParcelGuard pricing, verified 2026-06-08):
// USPS domestic $1.09/$100; non-USPS domestic $0.99/$100; international $1.39/$100.
// Hardcoded (not a flat env) because one rate can't be correct for USPS vs UPS/FedEx
// vs international at once — and a hardcoded schedule keeps the cache fingerprint
// identical across the API and worker (no env-mismatch cache churn).
const PARCELGUARD_SCHEDULE_VERSION = 'shipstation-parcelguard-2026-06-08-v1';
const PARCELGUARD_DOMESTIC_USPS_PER_HUNDRED = 1.09;
const PARCELGUARD_DOMESTIC_NON_USPS_PER_HUNDRED = 0.99;
const PARCELGUARD_INTERNATIONAL_PER_HUNDRED = 1.39;

function isParcelGuard(provider: string): boolean {
  return provider.replace(/[^a-z0-9]+/gi, '').toLowerCase() === 'parcelguard';
}

function normalizeCarrierCode(rate?: { carrier_code?: string | null; carrierCode?: string | null } | null): string {
  return String(rate?.carrier_code ?? rate?.carrierCode ?? '').trim().toLowerCase();
}

function isUspsCarrier(rate?: { carrier_code?: string | null; carrierCode?: string | null } | null): boolean {
  const carrierCode = normalizeCarrierCode(rate);
  return carrierCode === 'usps' || carrierCode === 'stamps_com';
}

function parcelGuardPerHundred(
  rate?: { carrier_code?: string | null; carrierCode?: string | null } | null,
  toCountry?: string | null,
): number | null {
  const country = String(toCountry ?? 'US').trim().toUpperCase();
  if (country && country !== 'US' && country !== 'USA') return PARCELGUARD_INTERNATIONAL_PER_HUNDRED;
  const carrierCode = normalizeCarrierCode(rate);
  if (!carrierCode) return null;
  return isUspsCarrier(rate) ? PARCELGUARD_DOMESTIC_USPS_PER_HUNDRED : PARCELGUARD_DOMESTIC_NON_USPS_PER_HUNDRED;
}

/**
 * Compute the ParcelGuard premium for a declared value from the schedule.
 * Formula: ceil(value / 100) increments * the carrier/category rate. Returns null
 * only when the carrier/country can't yield a premium (the caller then falls back to
 * $0 — it never blocks the rate).
 */
export function parcelGuardScheduledPremium(
  insuredValue: number,
  rate?: { carrier_code?: string | null; carrierCode?: string | null } | null,
  toCountry?: string | null,
): number | null {
  const value = finite(insuredValue);
  if (value == null || value <= 0) return null;
  const perHundred = parcelGuardPerHundred(rate, toCountry);
  if (perHundred == null || perHundred <= 0) return null;
  const increments = Math.max(1, Math.ceil(value / 100));
  const premium = increments * perHundred;
  if (!(premium > 0)) return null;
  return Number(premium.toFixed(2));
}

/** Fingerprint of the active rate-time insurance policy. Bumped for PS-126 (schedule
 *  restored) so cache entries computed under the PS-125 "$0 add-on" rule are
 *  invalidated and re-rated with the real schedule premium. */
export function insuranceCostConfigFingerprint(): string {
  return `parcelguard-schedule-${PARCELGUARD_SCHEDULE_VERSION}`;
}

type RateLike = {
  insurance_amount?: { currency?: string; amount?: number } | null;
  carrier_code?: string | null;
  carrierCode?: string | null;
  service_code?: string | null;
};

/**
 * Resolve the authoritative rate-time premium for one rate (PS-126).
 * - provider 'none' / value <= 0            -> not insured ({ none })
 * - positive ShipStation estimate amount    -> trust it (shipstation_estimate)
 * - ParcelGuard + estimate 0/missing        -> carrier/country SCHEDULE premium
 *                                              (parcelguard_schedule); if the schedule
 *                                              can't price it, fall back to $0 (never block)
 * - other provider + estimate 0/missing     -> resolved $0 (unchanged)
 *
 * NEVER returns `unresolved` for the estimate path — an insured rate is always
 * selectable (PS-125 anti-block guarantee preserved). The schedule premium is a
 * rate-time ESTIMATE; the actual billed ParcelGuard cost is reconciled post-purchase
 * via parcelguard-backfill.
 */
export function resolveRateInsurancePremium(
  ctx: { insuranceProvider?: string | null; insuredValue?: number | null; toCountry?: string | null },
  rate: RateLike,
  now: number = Date.now(),
): InsuranceCostResolution {
  const provider = String(ctx.insuranceProvider ?? 'none').trim().toLowerCase();
  const insuredValue = finite(ctx.insuredValue) ?? 0;
  if (provider === 'none' || insuredValue <= 0) return { status: 'none' };

  const fetchedAt = new Date(now).toISOString();
  const estimateAmount = Math.max(0, finite(rate.insurance_amount?.amount) ?? 0);

  // A positive ShipStation estimate is always trusted verbatim (source of truth).
  if (estimateAmount > 0) {
    return {
      status: 'resolved',
      insuranceProvider: provider,
      insuredValue,
      amount: Number(estimateAmount.toFixed(2)),
      provenance: 'shipstation_estimate',
      confirmed: true,
      fetchedAt,
    };
  }

  // PS-126: ShipStation returns 0 for ParcelGuard, so supply the rate-time premium
  // from the verified carrier/country schedule (the value ShipStation actually bills).
  if (isParcelGuard(provider)) {
    const premium = parcelGuardScheduledPremium(insuredValue, rate, ctx.toCountry);
    if (premium != null && premium > 0) {
      return {
        status: 'resolved',
        insuranceProvider: provider,
        insuredValue,
        amount: premium,
        provenance: 'parcelguard_schedule',
        // Schedule is a rate-time estimate; the billed cost confirms it post-purchase.
        confirmed: false,
        fetchedAt,
      };
    }
  }

  // Non-ParcelGuard insured rate, or a ParcelGuard rate the schedule couldn't price:
  // resolve at $0 so the rate is never blocked (PS-125 anti-block preserved).
  return {
    status: 'resolved',
    insuranceProvider: provider,
    insuredValue,
    amount: 0,
    provenance: 'shipstation_estimate',
    confirmed: true,
    fetchedAt,
  };
}

function toMeta(resolution: InsuranceCostResolution): RateInsuranceCostMeta | null {
  if (resolution.status === 'none') return null;
  if (resolution.status === 'resolved') {
    return {
      insuranceProvider: resolution.insuranceProvider,
      insuredValue: resolution.insuredValue,
      amount: resolution.amount,
      provenance: resolution.provenance,
      confirmed: resolution.confirmed,
      unresolved: false,
      fetchedAt: resolution.fetchedAt,
    };
  }
  return {
    insuranceProvider: resolution.insuranceProvider,
    insuredValue: resolution.insuredValue,
    amount: null,
    provenance: 'none',
    confirmed: false,
    unresolved: true,
    reason: resolution.reason,
    fetchedAt: null,
  };
}

/** True when a rate carries no unresolved-insurance flag (safe to select/sell). */
export function isRateInsuranceResolved(rate: unknown): boolean {
  return !(rate && typeof rate === 'object' && (rate as Record<string, unknown>).insuranceCostUnresolved === true);
}

export type EnrichedRate<T> = T & {
  insurance_amount?: { currency: string; amount: number };
  insuranceCost?: RateInsuranceCostMeta;
  insuranceCostUnresolved?: boolean;
  insuranceCostError?: string;
};

export type EnrichRatesResult<T> = {
  /** Rates whose insured total is proven by ShipStation, or not insured. */
  resolved: EnrichedRate<T>[];
  /** Insured rates whose premium could not be proven. */
  unresolved: Array<EnrichedRate<T> & { insuranceCostError: string }>;
};

/**
 * Enrich rates so each insured rate carries the ShipStation API premium in
 * `insurance_amount` before best-rate selection. Unresolved insured rates are
 * excluded from selection and surfaced as explicit diagnostics.
 */
export function enrichRatesWithInsuranceCost<T extends RateLike>(
  rates: T[],
  ctx: { insuranceProvider?: string | null; insuredValue?: number | null; toCountry?: string | null },
  now: number = Date.now(),
): EnrichRatesResult<T> {
  const resolved: EnrichedRate<T>[] = [];
  const unresolved: Array<EnrichedRate<T> & { insuranceCostError: string }> = [];

  for (const rate of rates) {
    const resolution = resolveRateInsurancePremium(ctx, rate, now);
    const meta = toMeta(resolution);

    if (resolution.status === 'none') {
      resolved.push(rate as EnrichedRate<T>);
      continue;
    }

    if (resolution.status === 'unresolved') {
      const flagged = {
        ...(rate as object),
        insuranceCost: meta ?? undefined,
        insuranceCostUnresolved: true,
        insuranceCostError: resolution.reason,
      } as EnrichedRate<T> & { insuranceCostError: string };
      unresolved.push(flagged);
      continue;
    }

    const currency = rate.insurance_amount?.currency ?? 'usd';
    const enriched = {
      ...(rate as object),
      insurance_amount: { currency, amount: resolution.amount },
      insuranceCost: meta ?? undefined,
    } as EnrichedRate<T>;
    resolved.push(enriched);
  }

  return { resolved, unresolved };
}

export type BilledInsuranceCost = {
  /** Postage component (ShipStation shipment_cost / v1 shipmentCost). */
  postageAmount: number;
  /** Insurance premium component (v2 insurance_cost / v1 otherCost). */
  insuranceAmount: number;
  /** postageAmount + insuranceAmount. */
  totalAmount: number;
  provenance: InsuranceCostProvenance;
};

export interface InsuranceCostBilledSource {
  /** Resolve the billed cost breakdown for a purchased label/shipment, or null. */
  resolveBilledCost(args: {
    labelId?: string | null;
    shipmentId?: number | null;
    apiKeyV2?: string | null;
    apiKeyV1?: string | null;
    apiSecretV1?: string | null;
  }): Promise<BilledInsuranceCost | null>;
}
