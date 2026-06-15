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
import { CARRIER_DECLARED_VALUE_FREE_CAP, DIRECT_UPS_CARRIER_INSURANCE_VERIFIED } from '../../lib/carrier-account-registry';

export type InsuranceCostProvenance =
  | 'none'
  | 'shipstation_estimate'
  | 'parcelguard_schedule'
  // PS-170: direct-carrier declared value (e.g. UPS's free first $100) — a $0 rate-time
  // premium. Only emitted when the account capability says carrier insurance is purchasable
  // (DIRECT_UPS_CARRIER_INSURANCE_VERIFIED); otherwise the rate stays on the ParcelGuard schedule.
  | 'carrier_declared_value'
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
//
// Billed-data confirmation (2026-06-09): across 31 purchased insured labels read from
// ShipStation, USPS billed exactly $1.09 (25/25) and UPS exactly $0.99 (6/6) at $100
// insured — matching this schedule to the cent. FedEx ($0.99, the non-USPS rate) and
// international ($1.39) are not yet confirmed by a purchased label (no insured FedEx /
// international shipment on record); re-verify against billed insurance_cost when one exists.
// PS-171 (2026-06-10): version bumped to invalidate cached rates priced under the carrier-only
// schedule (FedEx Ground Economy was wrongly $0.99 instead of the postal/economy $1.09 tier).
const PARCELGUARD_SCHEDULE_VERSION = 'shipstation-parcelguard-2026-06-10-v2';
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

function normalizeServiceText(value?: string | null): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// PS-171: FedEx Ground Economy / Parcel Select (formerly SmartPost) is a postal/economy-tier service that
// ShipStation prices ParcelGuard at the USPS $1.09/$100 tier — NOT the generic non-USPS $0.99 — even though
// the carrier is FedEx. Classify by SERVICE (code/name/type), not carrier alone. Evidence: HUGRAB order
// #1440 (FedEx Ground® Economy Parcel Select, ParcelGuard $100) — PrepShip showed +$0.99/$8.06, ShipStation
// +$1.09/$8.16. Known service codes: fedex_ground_economy_parcel_select, walmart_shipping_fedex_*_ground_economy,
// easypost_fedex_fedexdefault_smart_post. Normalized contains-match on 'groundeconomy'/'smartpost' catches all
// variants without false-matching normal FedEx Ground ('fedexground'). Do NOT treat all FedEx as $1.09.
function isPostalEconomyParcelGuardService(rate?: RateLike | null): boolean {
  const blob = [
    normalizeServiceText(rate?.service_code ?? rate?.serviceCode),
    normalizeServiceText(rate?.service_name ?? rate?.serviceName),
    normalizeServiceText(rate?.service_type),
  ].join(' ');
  return blob.includes('groundeconomy') || blob.includes('smartpost');
}

function parcelGuardPerHundred(
  rate?: RateLike | null,
  toCountry?: string | null,
): number | null {
  const country = String(toCountry ?? 'US').trim().toUpperCase();
  if (country && country !== 'US' && country !== 'USA') return PARCELGUARD_INTERNATIONAL_PER_HUNDRED;
  const carrierCode = normalizeCarrierCode(rate);
  if (!carrierCode) return null;
  // PS-171: USPS AND postal/economy-tier services (FedEx Ground Economy / SmartPost) bill at $1.09/$100.
  if (isUspsCarrier(rate) || isPostalEconomyParcelGuardService(rate)) return PARCELGUARD_DOMESTIC_USPS_PER_HUNDRED;
  return PARCELGUARD_DOMESTIC_NON_USPS_PER_HUNDRED;
}

/**
 * Compute the ParcelGuard premium for a declared value from the schedule.
 * Formula: ceil(value / 100) increments * the carrier/category rate. Returns null
 * only when the carrier/country can't yield a premium (the caller then falls back to
 * $0 — it never blocks the rate).
 */
export function parcelGuardScheduledPremium(
  insuredValue: number,
  rate?: RateLike | null,
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

// PS-261 (best-effort, UNCONFIRMED) — EasyPost charges its OWN insurance fee (a paid amount
// on the bought shipment), NOT ParcelGuard. EasyPost's published insurance is ~1% of the
// insured value with a ~$0.50 minimum. This rate-time ESTIMATE stops an insured EasyPost
// candidate from being compared at $0 (artificially cheapest) against ParcelGuard-priced
// ShipStation rates in the combined cheapest pick. It is intentionally an estimate: the
// EasyPost connector does not yet return the real billed insurance fee (a source-of-truth
// follow-up — createLabelEasyPost discards it), so the persisted post-purchase cost is a
// separate slice. TODO(PS-261): re-verify this schedule against a purchased EasyPost label
// and replace it with the connector's actual reported insurance_cost.
const EASYPOST_INSURANCE_MIN = 0.5;
const EASYPOST_INSURANCE_PER_DOLLAR = 0.01; // 1% of insured value
export function easyPostScheduledPremium(insuredValue: number): number | null {
  const value = finite(insuredValue);
  if (value == null || value <= 0) return null;
  const premium = Math.max(EASYPOST_INSURANCE_MIN, value * EASYPOST_INSURANCE_PER_DOLLAR);
  return premium > 0 ? Number(premium.toFixed(2)) : null;
}

/** Fingerprint of the active rate-time insurance policy. Bumped for PS-126 (schedule
 *  restored) so cache entries computed under the PS-125 "$0 add-on" rule are
 *  invalidated and re-rated with the real schedule premium. PS-170: the direct-UPS
 *  carrier-declared-value gate is folded in too, so flipping the gate invalidates cached
 *  rates and re-prices direct-UPS HUGRAB candidates (parcelguard <-> carrier $0). */
export function insuranceCostConfigFingerprint(): string {
  return `parcelguard-schedule-${PARCELGUARD_SCHEDULE_VERSION}|carrier-dv=${DIRECT_UPS_CARRIER_INSURANCE_VERIFIED ? 'on' : 'off'}`;
}

type RateLike = {
  insurance_amount?: { currency?: string; amount?: number } | null;
  carrier_code?: string | null;
  carrierCode?: string | null;
  service_code?: string | null;
  // PS-171: service fields used to classify postal/economy-tier ParcelGuard pricing (FedEx Ground Economy
  // / SmartPost → the USPS $1.09/$100 tier instead of the generic non-USPS $0.99).
  serviceCode?: string | null;
  service_name?: string | null;
  serviceName?: string | null;
  service_type?: string | null;
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
  let provider = String(ctx.insuranceProvider ?? 'none').trim().toLowerCase();
  const insuredValue = finite(ctx.insuredValue) ?? 0;
  if (provider === 'none' || insuredValue <= 0) return { status: 'none' };

  // PS-170 defense-in-depth: carrier declared value is free ONLY for the first $100. The
  // provider-decision owners (resolveEffectiveInsurance / rates.ts) already cap this, so
  // 'carrier' should never arrive here above the cap — but if it does, price it as ParcelGuard
  // (any value, scheduled premium) rather than undercharging/under-insuring the excess.
  if (provider === 'carrier' && insuredValue > CARRIER_DECLARED_VALUE_FREE_CAP) provider = 'parcelguard';

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

  // PS-170: carrier declared value — a direct-carrier account insuring the first $100 for
  // $0 (verified-and-enabled accounts only; the capability resolver upstream decides this,
  // and only ever passes provider 'carrier' here when DIRECT_UPS_CARRIER_INSURANCE_VERIFIED).
  // $0 is the real billed cost for $100 declared value on a direct UPS contract, so it is
  // confirmed (not an estimate). HUGRAB defaults to exactly $100, where declared value is free.
  if (provider === 'carrier') {
    return {
      status: 'resolved',
      insuranceProvider: provider,
      insuredValue,
      amount: 0,
      provenance: 'carrier_declared_value',
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

  // PS-261: a non-ParcelGuard insured provider this resolver can't price (a direct-carrier
  // provider whose cost is owned elsewhere, the dead 'shipsurance' member, or any future
  // value), or a ParcelGuard rate the schedule couldn't price. Resolve at $0 so the rate is
  // NEVER blocked (PS-125 anti-block preserved) — but mark it UNCONFIRMED. A $0 here is a
  // "couldn't price" fallback, NOT a verified $0 premium (the genuine free-tier $0 is the
  // 'carrier' branch above, which stays confirmed). Confirming this $0 falsely asserted an
  // insured rate carries no premium, letting downstream treat an unpriced provider as final.
  return {
    status: 'resolved',
    insuranceProvider: provider,
    insuredValue,
    amount: 0,
    provenance: 'shipstation_estimate',
    confirmed: false,
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
 *
 * PS-170 — `resolveProvider` is an OPTIONAL per-candidate provider hook. The request
 * carries ONE provider (ctx.insuranceProvider), but each candidate rate runs on a
 * different carrier account, and a direct-UPS account can insure $100 for $0 via carrier
 * declared value while the ShipStation-brokered ones must use ParcelGuard. The hook lets
 * the caller (services/rates.ts) pick the provider PER rate from the account capability.
 *
 * It is consulted ONLY when the request-level provider is ParcelGuard, so it can only ever
 * DOWNGRADE a candidate ParcelGuard→carrier (cheaper, still insured) on an eligible account
 * — never override an operator who explicitly chose `carrier`/`shipsurance`, and never
 * upgrade `none`. With DIRECT_UPS_CARRIER_INSURANCE_VERIFIED=false the hook returns
 * ParcelGuard for every account, so enrichment is byte-identical to pre-PS-170.
 */
export function enrichRatesWithInsuranceCost<T extends RateLike>(
  rates: T[],
  ctx: { insuranceProvider?: string | null; insuredValue?: number | null; toCountry?: string | null },
  now: number = Date.now(),
  resolveProvider?: (rate: T) => string | null,
): EnrichRatesResult<T> {
  const resolved: EnrichedRate<T>[] = [];
  const unresolved: Array<EnrichedRate<T> & { insuranceCostError: string }> = [];
  const requestIsParcelGuard = isParcelGuard(String(ctx.insuranceProvider ?? ''));

  for (const rate of rates) {
    // Per-candidate provider refinement (PS-170) — only from the ParcelGuard request path.
    const perRateProvider = requestIsParcelGuard && resolveProvider
      ? resolveProvider(rate) ?? ctx.insuranceProvider
      : ctx.insuranceProvider;
    const rateCtx = perRateProvider === ctx.insuranceProvider ? ctx : { ...ctx, insuranceProvider: perRateProvider };
    const resolution = resolveRateInsurancePremium(rateCtx, rate, now);
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
