// PS-125 - Canonical owner of the ShipStation insurance premium on a rate.
//
// ShipStation calculates insurance. PrepShip records and displays the API-returned
// amount; it does not price ParcelGuard/carrier insurance from a local schedule.
// A positive ShipStation `insurance_amount` is trusted as-is.
//
// PS-125 (supersedes the earlier PS-108 "block zero" rule): a $0 - or omitted -
// ShipStation insurance add-on is a VALID resolved premium, NOT an error. Insurance
// can legitimately add $0; PrepShip still rates/selects the order and shows the
// add-on as $0.00. We never block a real postage quote just because the rate-time
// insurance add-on is zero. The real billed ParcelGuard cost (if any) is reconciled
// AFTER label purchase via the actual-cost path (v2 `insurance_cost` / v1 `otherCost`),
// see parcelguard-backfill. HUGRAB still defaults to ParcelGuard / insured value 100
// upstream (services/rates.ts); this module only interprets the returned premium.

export type InsuranceCostProvenance =
  | 'none'
  | 'shipstation_estimate'
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

/** Fingerprint of the active rate-time insurance policy. Bumped for PS-125 so any
 *  cache entries computed under the old "zero -> unresolved -> excluded" rule are
 *  invalidated and re-rated under the "zero is a valid $0 add-on" rule. */
export function insuranceCostConfigFingerprint(): string {
  return 'shipstation-api-insurance-v2-zero-ok';
}

type RateLike = {
  insurance_amount?: { currency?: string; amount?: number } | null;
  carrier_code?: string | null;
  carrierCode?: string | null;
  service_code?: string | null;
};

/**
 * Resolve the authoritative rate-time premium for one rate (PS-125).
 * - provider 'none' / value <= 0            -> not insured ({ none })
 * - positive ShipStation estimate amount    -> resolved at that amount
 * - explicit zero ($0 / '0' / 0.00)         -> resolved at $0.00 (valid: no add-on)
 * - omitted / null estimate amount          -> resolved at $0.00 (ShipStation did not
 *                                              itemize an add-on for this insured rate;
 *                                              treated as "no add-on at rate time", with
 *                                              the real billed cost reconciled at purchase)
 *
 * An insured rate is therefore NEVER excluded for a zero/missing premium. A positive
 * estimate is still trusted; only a genuinely non-finite/negative amount is clamped.
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
  // PS-125: explicit zero, '0', 0.00, and omitted/null all collapse to a valid $0
  // add-on. finite() coerces '0'/0.00 -> 0 and null/undefined/NaN -> null (=> 0 here).
  const estimateAmount = Math.max(0, finite(rate.insurance_amount?.amount) ?? 0);
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
