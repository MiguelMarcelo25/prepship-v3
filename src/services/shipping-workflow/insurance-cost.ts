// PS-108 — Canonical owner of the ParcelGuard / insurance PREMIUM amount on a rate.
//
// Background (see docs/ps-108-shipstation-parcelguard-cost-source.md):
//   ShipStation's POST /v2/rates/estimate accepts insurance_provider + insured_value
//   but returns `insurance_amount: 0` for ParcelGuard. That zero flows through
//   rateTotal() -> pickBestRate() -> the saved bestRate and the selectedRateAuthorityKey
//   (which hashes insurance_amount), so PrepShip selects/stores a POSTAGE-ONLY total
//   even though the purchased label bills the ParcelGuard premium. The fix belongs at
//   the rate-fetch boundary: populate the authoritative premium BEFORE best-rate
//   selection so every insurance-aware downstream (sort, cache, proof, dedupe) tells the
//   truth automatically.
//
// This module is PURE (no DB, no network) so the premium logic is unit-testable offline
// and never buys postage. Network-backed BILLED reads (v2 /labels/{id}, v1 /shipments)
// used by the Phase-3 backfill are provided through the InsuranceCostBilledSource
// boundary and implemented at the call site that has network access.
//
// Guardrails honored:
//   - No hardcoded observed premium. The rate-time premium is a CONFIGURABLE schedule
//     formula; the observed calibration value appears only in the Phase-4 test fixture.
//     Provenance marks a scheduled premium unconfirmed until live-confirmed.
//   - An insured rate whose premium cannot be PROVEN is marked `insuranceCostUnresolved`
//     and must be excluded from best-rate selection (never fall back to raw postage).

export type InsuranceCostProvenance =
  | 'none' //               not an insured rate
  | 'shipstation_estimate' // ShipStation returned a non-zero premium in the estimate
  | 'parcelguard_schedule' // computed from the backend-owned ParcelGuard schedule
  | 'shipstation_v2_label' // billed: GET /v2/labels/{id}.insurance_cost (backfill)
  | 'shipstation_v1_shipment'; // billed: GET /v1/shipments/{id}.otherCost (backfill)

export type InsuranceCostResolution =
  | { status: 'none' }
  | {
      status: 'resolved';
      insuranceProvider: string;
      insuredValue: number;
      amount: number;
      provenance: InsuranceCostProvenance;
      /** True until a live ShipStation billed read confirms the schedule figure. */
      confirmed: boolean;
      fetchedAt: string;
    }
  | {
      status: 'unresolved';
      insuranceProvider: string;
      insuredValue: number;
      reason: string;
    };

/** Audit blob stamped onto each enriched rate so best_rate_json / proof carry the
 *  component breakdown PS-108 requires. */
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

// ── Configuration ──────────────────────────────────────────────────────────
// Rate-time premium source. `schedule` (default) computes the premium from the
// configurable ParcelGuard schedule when the estimate returns 0. `estimate_only`
// trusts only a non-zero estimate and marks ParcelGuard zeros unresolved. `block`
// forces every ParcelGuard rate that lacks a non-zero estimate premium to unresolved.
export type ParcelGuardRateTimeSource = 'schedule' | 'estimate_only' | 'block';

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parcelGuardRateTimeSource(): ParcelGuardRateTimeSource {
  const raw = (readEnv('PARCELGUARD_RATE_TIME_SOURCE') ?? 'schedule').toLowerCase();
  if (raw === 'estimate_only' || raw === 'block') return raw;
  return 'schedule';
}

// Documented InsureShield/ParcelGuard base rate: ~$1.00 per $100 of declared value,
// with a per-shipment minimum. These are DEFAULTS — DJ pins the live-confirmed figure
// via env once Phase-1 live confirmation is done. They are deliberately NOT the observed
// billed premium, so no magic billed constant lives in runtime (the observed calibration
// value appears only in the Phase-4 test fixture).
const PARCELGUARD_DEFAULT_PER_HUNDRED = 1.0;
const PARCELGUARD_DEFAULT_MINIMUM = 1.0;

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parcelGuardScheduleConfig(): { perHundred: number; minimum: number } {
  const perHundred = finite(readEnv('PARCELGUARD_PREMIUM_PER_100')) ?? PARCELGUARD_DEFAULT_PER_HUNDRED;
  const minimum = finite(readEnv('PARCELGUARD_PREMIUM_MIN')) ?? PARCELGUARD_DEFAULT_MINIMUM;
  return {
    perHundred: Math.max(0, perHundred),
    minimum: Math.max(0, minimum),
  };
}

/** Whether the active schedule has been pinned to a live-confirmed figure
 *  (PARCELGUARD_PREMIUM_CONFIRMED=true). Default false => provenance unconfirmed. */
export function parcelGuardScheduleConfirmed(): boolean {
  return (readEnv('PARCELGUARD_PREMIUM_CONFIRMED') ?? '').toLowerCase() === 'true';
}

/**
 * Compute the ParcelGuard premium for a declared value from the configurable schedule.
 * Formula: ceil(value / 100) increments * perHundred, floored at the minimum. Returns
 * null when the schedule cannot yield a positive premium (treated as unresolved).
 */
export function parcelGuardScheduledPremium(insuredValue: number): number | null {
  const value = finite(insuredValue);
  if (value == null || value <= 0) return null;
  const { perHundred, minimum } = parcelGuardScheduleConfig();
  const increments = Math.max(1, Math.ceil(value / 100));
  const premium = Math.max(minimum, increments * perHundred);
  if (!(premium > 0)) return null;
  return Number(premium.toFixed(2));
}

/** Fingerprint of the active rate-time insurance config, so the rate cache busts when
 *  the schedule/source changes materially (PS-108 requirement #4). */
export function insuranceCostConfigFingerprint(): string {
  const { perHundred, minimum } = parcelGuardScheduleConfig();
  return [
    `src=${parcelGuardRateTimeSource()}`,
    `p100=${perHundred}`,
    `min=${minimum}`,
    `cfm=${parcelGuardScheduleConfirmed() ? 1 : 0}`,
  ].join(',');
}

// ── Resolution ─────────────────────────────────────────────────────────────

function isParcelGuard(provider: string): boolean {
  return provider.replace(/[^a-z0-9]+/gi, '').toLowerCase() === 'parcelguard';
}

type RateLike = {
  insurance_amount?: { currency?: string; amount?: number } | null;
  carrier_code?: string | null;
  service_code?: string | null;
};

/**
 * Resolve the authoritative rate-time premium for one rate. Pure & synchronous.
 *  - provider 'none' / value <= 0           -> { none }
 *  - estimate already returned a positive premium -> trust it (shipstation_estimate)
 *  - ParcelGuard + estimate 0:
 *      schedule mode + positive scheduled premium -> resolved (parcelguard_schedule)
 *      otherwise                                  -> unresolved (block, never raw postage)
 *  - non-ParcelGuard + estimate 0 -> resolved 0 (out of PS-108 scope; unchanged behavior)
 */
export function resolveRateInsurancePremium(
  ctx: { insuranceProvider?: string | null; insuredValue?: number | null },
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

  if (!isParcelGuard(provider)) {
    // Non-ParcelGuard insured rate with a 0 estimate: out of PS-108 scope. Leave as a
    // resolved $0 so behavior is unchanged for carrier/shipsurance providers.
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

  const mode = parcelGuardRateTimeSource();
  if (mode === 'schedule') {
    const premium = parcelGuardScheduledPremium(insuredValue);
    if (premium != null && premium > 0) {
      return {
        status: 'resolved',
        insuranceProvider: provider,
        insuredValue,
        amount: premium,
        provenance: 'parcelguard_schedule',
        confirmed: parcelGuardScheduleConfirmed(),
        fetchedAt,
      };
    }
  }

  return {
    status: 'unresolved',
    insuranceProvider: provider,
    insuredValue,
    reason:
      mode === 'block'
        ? 'ParcelGuard premium blocked (PARCELGUARD_RATE_TIME_SOURCE=block) — re-rate with a proven insured total.'
        : 'ParcelGuard premium unresolved: ShipStation estimate returned $0 and no confirmed insurance cost source is available — re-rate before selecting.',
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
  /** Rates whose insured total is proven (resolved or not-insured). Safe to select. */
  resolved: EnrichedRate<T>[];
  /** Insured rates whose premium could not be proven. Excluded from selection. */
  unresolved: Array<EnrichedRate<T> & { insuranceCostError: string }>;
};

/**
 * Enrich a list of rates so each insured rate carries the authoritative ParcelGuard
 * premium in `insurance_amount` BEFORE best-rate selection. Splits the list into
 * `resolved` (safe to select) and `unresolved` (insured but premium unproven — must be
 * excluded from selection and surfaced as an explicit error state). Pure & synchronous.
 */
export function enrichRatesWithInsuranceCost<T extends RateLike>(
  rates: T[],
  ctx: { insuranceProvider?: string | null; insuredValue?: number | null },
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

    // resolved — stamp the authoritative premium onto insurance_amount so every
    // insurance-aware downstream (rateTotal/pickBestRate/cache/proof) sees the truth.
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

// ── Billed source boundary (Phase 3 backfill) ────────────────────────────────
// Provider-agnostic so the backfill can read the authoritative BILLED premium without
// this pure module importing the network client.

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
