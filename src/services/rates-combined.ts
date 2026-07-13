/**
 * PS-203 (stage 3) — the canonical owner of COMBINED best-rate selection.
 *
 * "Best rate" must mean the cheapest across the order's REQUIRED carrier
 * universe — ShipStation AND the visible direct carriers (Shipp, Walmart
 * Shipping, direct UPS…). Before this module, the only code that combined the
 * two families lived inline in the /rates/browse handler; every other
 * persisting path (the backfill, the cached fast-path) compared a
 * ShipStation-only universe and self-certified it complete — that is how a
 * saved $10.44 ShipStation winner survived next to a $9.27 direct rate.
 *
 * PURE module (zero io): callers fetch the two families (getRates +
 * getDirectCarrierRatesForRateInput, which now applies the SAME markup rules
 * to direct rates so the customer-billing field is available) and delegate
 * the merge, the single cheapest-pick, the per-carrier statuses, and the
 * combined-universe completeness here. /rates/browse and the rates backfill
 * both consume this one owner; the offline guard runs the $9.27-beats-$10.44
 * fixture and the incomplete-on-direct-error rule against it directly.
 */
import type { BestRateWorkflowCarrierStatus } from './shipping-workflow/best-rate-workflow-dto';
import { normalizeShippingRateMoney } from './shipping-workflow/shipping-rate-money-normalizer';

type MoneyAmount = { amount?: number };

export type CombinableRate = Record<string, any> & {
  carrier_id?: string;
  service_code?: string | null;
  serviceCode?: string | null;
  service?: string | null;
  shipping_amount?: MoneyAmount;
  other_amount?: MoneyAmount;
  confirmation_amount?: MoneyAmount;
  insurance_amount?: MoneyAmount;
  cShippingRateAmount?: number | string | null;
  selectedRateCost?: number | string | null;
};

export type CombinableSsDiagnostic = {
  carrierId: string;
  accountId?: string | null;
  carrierCode?: string | null;
  nickname?: string | null;
  status: string;
  rateCount?: number;
  durationMs?: number;
  limiterWaitMs?: number;
  attempts?: number;
  retryable?: boolean;
  error?: string;
  // PS-271 (Layer 4): a direct-carrier diagnostic for an accepted-thin partial (Shipp Layer 1).
  // Additive; absent today and for ShipStation / non-thin direct passes.
  thin?: boolean;
};

export type CombineCarrierUniversesInput = {
  /** ShipStation rates AFTER the route's requested-set / eligibility filtering. */
  ssRates: CombinableRate[];
  ssCacheKey: string;
  ssCached: boolean;
  ssDiagnostics: CombinableSsDiagnostic[];
  /** Result of getDirectCarrierRatesForRateInput (rates already markup-uniform). */
  directRates: CombinableRate[];
  directDiagnostics: CombinableSsDiagnostic[];
  /** The carriers the caller explicitly requested (browse carrierIds), if any. */
  requestedCarrierIds?: string[] | null;
  /** ShipStation account list for status naming: [carrierId, displayName]. */
  accountNamesByCarrierId: Map<string, string>;
  /** All known SS account carrier ids (status rows when nothing was requested). */
  accountCarrierIds: string[];
  /** cachedOnly && !forceRefresh && !forceLive — missing carriers show 'loading'. */
  isCachedOnlyLookup: boolean;
};

export type CombinedRateSelection = {
  combinedRates: CombinableRate[];
  rankedEligibleRates: CombinableRate[];
  cheapest: CombinableRate | null;
  secondCheapest: CombinableRate | null;
  combinedRequestKey: string;
  carrierStatuses: BestRateWorkflowCarrierStatus[];
  directCarrierStatuses: BestRateWorkflowCarrierStatus[];
  combinedCarrierStatuses: BestRateWorkflowCarrierStatus[];
  /** Direct diagnostics tagged source:'direct' (the payload emits these alone too). */
  directCarrierDiagnostics: Array<Record<string, unknown>>;
  combinedCarrierDiagnostics: Array<Record<string, unknown>>;
  bestRateComplete: boolean;
  // PS-271 (Layer 4): true when the cheapest pick came from a carrier that answered THIN (Shipp
  // accepted-partial). Display-only/additive — `false` today and whenever the winner is from a full
  // pass; the FE can label such a best "thin/unproven". Independent of bestRateComplete (a thin best
  // is already not-complete) so a consumer can distinguish "thin winner" from other incompleteness.
  bestRateThin: boolean;
};

export function rateTotal(rate: CombinableRate): number {
  return normalizeShippingRateMoney(rate).cShippingRateAmount ?? 0;
}

/** Internal carrier cost total. Used for the lower/admin cost line, not the primary Best Rate pick basis. */
export function rateCostTotal(rate: CombinableRate): number {
  return normalizeShippingRateMoney(rate).selectedRateCost ?? 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

function moneyAmount(value: unknown): number | null {
  return finiteNumber(asRecord(value).amount);
}

function textPresent(value: unknown): boolean {
  return String(value ?? '').trim().length > 0;
}

function hasProviderError(rate: CombinableRate): boolean {
  const raw = asRecord(rate.raw);
  const candidates = [
    rate.error_messages,
    rate.errorMessages,
    raw.error_messages,
    raw.errorMessages,
  ];
  return candidates.some((value) =>
    Array.isArray(value)
      ? value.some(textPresent)
      : textPresent(value),
  );
}

function hasServiceCode(rate: CombinableRate): boolean {
  const raw = asRecord(rate.raw);
  return [
    rate.service_code,
    rate.serviceCode,
    rate.service,
    raw.service_code,
    raw.serviceCode,
    raw.service,
  ].some(textPresent);
}

function rateShippingComponent(rate: CombinableRate): number {
  const raw = asRecord(rate.raw);
  return firstFiniteNumber(
    rate.shipmentCost,
    raw.shipmentCost,
    rate.shipment_cost,
    raw.shipment_cost,
    moneyAmount(rate.shipping_amount),
    moneyAmount(raw.shipping_amount),
    rate.cost,
    raw.cost,
    rate.amount,
    raw.amount,
  ) ?? 0;
}

/**
 * The single definition of "a rate that can actually be charged." A candidate
 * must have a service code, no provider error, a positive postage/shipping
 * component, and a positive all-in total. This blocks ShipStation rows where
 * postage is $0 but insurance/other add-ons make the total look nonzero.
 */
export function isPricedRate(rate: CombinableRate): boolean {
  const total = rateTotal(rate);
  const shippingComponent = rateShippingComponent(rate);
  return (
    Number.isFinite(total) &&
    total > 0 &&
    Number.isFinite(shippingComponent) &&
    shippingComponent > 0 &&
    hasServiceCode(rate) &&
    !hasProviderError(rate)
  );
}

export function dedupeBrowseRates<T extends Record<string, any>>(rates: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const rate of rates) {
    const key = [
      String(rate.carrier_id ?? rate.carrierId ?? '').toLowerCase(),
      String(rate.service_code ?? rate.serviceCode ?? rate.service ?? '').toLowerCase(),
      Number(rateTotal(rate)).toFixed(4),
      Number(rate.other_amount?.amount ?? rate.otherCost ?? 0).toFixed(4),
      String(rate.requestFingerprint ?? rate.cacheKey ?? ''),
    ].join('|');
    if (!byKey.has(key)) byKey.set(key, rate);
  }
  return [...byKey.values()];
}

/**
 * PS-111: completeness is derived from carrier statuses — a best rate is
 * complete only when every carrier in the COMBINED universe reached a terminal
 * result (none loading, none errored). A failed direct carrier makes the
 * selection partial even when ShipStation answered cleanly.
 * PS-206: 'uncached' (no cached coverage in a cached-only lookup) is terminal
 * for the LOOKUP but the carrier was never actually checked — a selection over
 * an uncached carrier set is NEVER complete.
 */
function statusesComplete(statuses: ReadonlyArray<{ status: string; thin?: boolean }>): boolean {
  if (!statuses.length) return false;
  // PS-271 (Layer 4): a carrier that answered THIN (Shipp accepted-partial) is terminal but unproven —
  // a best sourced from it is not COMPLETE. status.thin is never set unless Layer 1 ran (default-inert);
  // mirrors isBestRateComplete in best-rate-workflow-dto. The three status checks stay on ONE line so the
  // PS-206 full-coverage guard's literal (rejects loading/error/uncached) still pins them.
  return statuses.every(
    (status) => status.status !== 'loading' && status.status !== 'error' && status.status !== 'uncached' && status.thin !== true,
  );
}

/**
 * PS-206: bounded per-carrier quoting — one slow/hung provider becomes a
 * per-carrier 'failed' diagnostic (with this reason) instead of holding the
 * whole combined response open. Pure (caller supplies the promise), so the
 * timeout rule is offline-testable without any provider call.
 */
export const DIRECT_CARRIER_QUOTE_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.DIRECT_CARRIER_QUOTE_TIMEOUT_MS ?? '15000', 10) || 15_000,
);

// Audit R-4 (2026-07-13): abort-capable variant. withCarrierQuoteTimeout races
// and ABANDONS the work — the losing provider call kept running (and, for
// ShipStation, retrying inside ssRequest) as a budget-burning zombie for up to
// ~7.5 min. This variant hands the caller an AbortSignal and aborts it when the
// deadline fires, so timeout means STOP THE WORK, not just stop waiting.
// Note: ssRequest's in-flight dedupe shares one HTTP promise across same-key
// callers, so an abort can cancel a shared request — the survivor's transient
// retry re-issues it; rare and preferable to zombie retries.
export function withAbortableCarrierQuoteTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  label: string,
  timeoutMs: number = DIRECT_CARRIER_QUOTE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    run(controller.signal),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} rate request timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export function withCarrierQuoteTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number = DIRECT_CARRIER_QUOTE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} rate request timed out after ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export function combineCarrierUniverses(input: CombineCarrierUniversesInput): CombinedRateSelection {
  const combinedRates = dedupeBrowseRates([...input.ssRates, ...input.directRates].filter(isPricedRate));
  const directCarrierIds = [
    ...new Set(input.directDiagnostics.map((diagnostic) => diagnostic.carrierId).filter(Boolean)),
  ];
  // Keep direct metadata in its own fingerprint part; appending with ":direct:"
  // mutated the final package fact (for example h=30:direct:...) and false-staled rows.
  const combinedRequestKey = directCarrierIds.length
    ? `${input.ssCacheKey}|dc=${directCarrierIds.sort().join(',')}`
    : input.ssCacheKey;
  // The SINGLE pick, on the marked/customer-rate basis. Internal carrier cost is carried
  // separately as Rate Cost. Only PRICED rates are
  // eligible — an unpriced/$0 rate (a ShipStation account that returned no amount)
  // must never be selected as best just because `?? 0` makes it look cheapest.
  const rankedEligibleRates = [...combinedRates]
    .sort((a, b) => (rateTotal(a) - rateTotal(b)) || (rateCostTotal(a) - rateCostTotal(b)));
  const cheapest = rankedEligibleRates[0] ?? null;
  const secondCheapest = rankedEligibleRates[1] ?? null;

  const statusCarrierIds = input.requestedCarrierIds?.length
    ? input.requestedCarrierIds
    : input.accountCarrierIds;
  const carriersWithRates = new Set(combinedRates.map((rate) => rate.carrier_id));
  const diagnosticsByCarrierId = new Map(
    input.ssDiagnostics.map((diagnostic) => [diagnostic.carrierId, diagnostic]),
  );
  const statusWhenFound = input.ssCached ? 'cached' : 'live';
  // PS-206: a cached-only lookup is TERMINAL — a carrier with no cached rates
  // was not checked ('uncached', live check required), it is not 'loading'
  // (nothing is in flight). 'loading' was the resting-state lie that left the
  // Rate Browser header stuck on "Checking carriers...".
  const missingStatus = input.isCachedOnlyLookup ? 'uncached' : 'unavailable';
  const carrierStatuses: BestRateWorkflowCarrierStatus[] = statusCarrierIds.map((id) => {
    const diagnostic = diagnosticsByCarrierId.get(id);
    const hasRates = carriersWithRates.has(id);
    const status: BestRateWorkflowCarrierStatus['status'] = hasRates
      ? statusWhenFound
      : diagnostic?.status === 'failed'
        ? 'error'
        : diagnostic?.status === 'empty'
          ? 'unavailable'
          : diagnostic?.status === 'loading'
            ? 'loading'
            : missingStatus;
    return {
      carrierId: id,
      accountId: diagnostic?.accountId ?? id,
      source: 'shipstation',
      carrierName: input.accountNamesByCarrierId.get(id) ?? diagnostic?.nickname ?? id,
      carrierCode: diagnostic?.carrierCode,
      nickname: diagnostic?.nickname,
      status,
      rateCount: hasRates ? combinedRates.filter((rate) => rate.carrier_id === id).length : diagnostic?.rateCount ?? 0,
      durationMs: diagnostic?.durationMs,
      limiterWaitMs: diagnostic?.limiterWaitMs,
      attempts: diagnostic?.attempts,
      retryable: diagnostic?.retryable,
      error: diagnostic?.error,
    };
  });
  const directCarrierStatuses: BestRateWorkflowCarrierStatus[] = input.directDiagnostics.map((diagnostic) => ({
    carrierId: diagnostic.carrierId,
    accountId: diagnostic.accountId,
    source: 'direct',
    carrierName: diagnostic.nickname ?? diagnostic.carrierId,
    carrierCode: diagnostic.carrierCode,
    nickname: diagnostic.nickname,
    status:
      diagnostic.status === 'ok'
        ? 'live'
        : diagnostic.status === 'failed'
          ? 'error'
          : diagnostic.status === 'skipped'
            ? 'blocked'
          : diagnostic.status === 'empty'
            ? 'unavailable'
            : diagnostic.status === 'cached'
              ? 'cached'
              // PS-206: cached-only lookups skip direct quoting entirely — the
              // rates service emits terminal 'uncached' diagnostics for every
              // visible direct account (live check required), never 'loading'.
              : diagnostic.status === 'uncached'
                ? 'uncached'
                : 'loading',
    rateCount: diagnostic.rateCount ?? 0,
    durationMs: diagnostic.durationMs,
    limiterWaitMs: diagnostic.limiterWaitMs,
    attempts: diagnostic.attempts,
    retryable: diagnostic.retryable,
    error: diagnostic.error,
    // PS-271 (Layer 4): carry the accepted-thin signal onto the carrier status so completeness
    // (statusesComplete / isBestRateComplete) and the FE can render thin/unproven. Additive.
    ...(diagnostic.thin === true ? { thin: true } : {}),
  }));
  const combinedCarrierStatuses = [...carrierStatuses, ...directCarrierStatuses];
  const directCarrierDiagnostics: Array<Record<string, unknown>> = input.directDiagnostics.map(
    (diagnostic) => ({ ...diagnostic, source: 'direct' }),
  );
  const combinedCarrierDiagnostics: Array<Record<string, unknown>> = [
    ...input.ssDiagnostics.map((diagnostic) => ({ ...diagnostic, source: 'shipstation' })),
    ...directCarrierDiagnostics,
  ];

  // PS-271 (Layer 4): is the cheapest pick from a carrier that answered THIN? Match the winner's
  // carrier_id to a direct status flagged thin. false today and whenever the winner is from a full
  // pass — purely additive/displayable.
  const thinCarrierIds = new Set(
    directCarrierStatuses.filter((status) => status.thin === true).map((status) => status.carrierId),
  );
  const bestRateThin = Boolean(cheapest && thinCarrierIds.has(String(cheapest.carrier_id ?? '')));

  return {
    combinedRates,
    rankedEligibleRates,
    cheapest,
    secondCheapest,
    combinedRequestKey,
    carrierStatuses,
    directCarrierStatuses,
    combinedCarrierStatuses,
    directCarrierDiagnostics,
    combinedCarrierDiagnostics,
    bestRateComplete: statusesComplete(combinedCarrierStatuses),
    bestRateThin,
  };
}
