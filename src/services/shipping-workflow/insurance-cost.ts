// PS-108 - Canonical owner of the ShipStation insurance premium on a rate.
//
// ShipStation calculates insurance. PrepShip records and displays the API-returned
// amount; it does not price ParcelGuard/carrier insurance from a local schedule.
// For rate shopping, a positive ShipStation `insurance_amount` is trusted. If an
// insured rate has a zero or missing insurance amount, the rate is marked
// unresolved and excluded from best-rate selection so we never sell a postage-only
// insured total. For purchased labels/backfills, callers use ShipStation billed
// fields such as v2 `insurance_cost` or v1 `otherCost`.

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

/** Fingerprint of the active rate-time insurance policy. */
export function insuranceCostConfigFingerprint(): string {
  return 'shipstation-api-insurance-v1';
}

type RateLike = {
  insurance_amount?: { currency?: string; amount?: number } | null;
  carrier_code?: string | null;
  carrierCode?: string | null;
  service_code?: string | null;
};

/**
 * Resolve the authoritative rate-time premium for one rate.
 * - provider 'none' / value <= 0 -> not insured
 * - positive ShipStation estimate insurance_amount -> resolved
 * - insured + zero/missing estimate insurance_amount -> unresolved
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
  const estimateAmount = finite(rate.insurance_amount?.amount) ?? 0;
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

  return {
    status: 'unresolved',
    insuranceProvider: provider,
    insuredValue,
    reason: `${provider} premium unresolved: ShipStation estimate returned no positive insurance_amount; re-rate or buy label only when ShipStation provides the insurance cost.`,
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
