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
 * to direct rates so the pick compares a uniform charge basis) and delegate
 * the merge, the single cheapest-pick, the per-carrier statuses, and the
 * combined-universe completeness here. /rates/browse and the rates backfill
 * both consume this one owner; the offline guard runs the $9.27-beats-$10.44
 * fixture and the incomplete-on-direct-error rule against it directly.
 */
import type { BestRateWorkflowCarrierStatus } from './shipping-workflow/best-rate-workflow-dto';

type MoneyAmount = { amount?: number };

export type CombinableRate = Record<string, any> & {
  carrier_id?: string;
  shipping_amount?: MoneyAmount;
  other_amount?: MoneyAmount;
  confirmation_amount?: MoneyAmount;
  insurance_amount?: MoneyAmount;
};

export type CombinableSsDiagnostic = {
  carrierId: string;
  carrierCode?: string | null;
  nickname?: string | null;
  status: string;
  rateCount?: number;
  durationMs?: number;
  error?: string;
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
  cheapest: CombinableRate | null;
  combinedRequestKey: string;
  carrierStatuses: BestRateWorkflowCarrierStatus[];
  directCarrierStatuses: BestRateWorkflowCarrierStatus[];
  combinedCarrierStatuses: BestRateWorkflowCarrierStatus[];
  /** Direct diagnostics tagged source:'direct' (the payload emits these alone too). */
  directCarrierDiagnostics: Array<Record<string, unknown>>;
  combinedCarrierDiagnostics: Array<Record<string, unknown>>;
  bestRateComplete: boolean;
};

/** The uniform CHARGE total a rate costs the customer — the single pick basis. */
export function rateTotal(rate: CombinableRate): number {
  return (
    Number(rate.shipping_amount?.amount ?? 0) +
    Number(rate.other_amount?.amount ?? 0) +
    Number(rate.confirmation_amount?.amount ?? 0) +
    Number(rate.insurance_amount?.amount ?? 0)
  );
}

export function dedupeBrowseRates<T extends Record<string, any>>(rates: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const rate of rates) {
    const key = [
      String(rate.carrier_id ?? rate.carrierId ?? '').toLowerCase(),
      String(rate.service_code ?? rate.serviceCode ?? rate.service ?? '').toLowerCase(),
      Number(rate.shipping_amount?.amount ?? rate.shipmentCost ?? rate.cost ?? rate.amount ?? 0).toFixed(4),
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
function statusesComplete(statuses: ReadonlyArray<{ status: string }>): boolean {
  if (!statuses.length) return false;
  return statuses.every(
    (status) => status.status !== 'loading' && status.status !== 'error' && status.status !== 'uncached',
  );
}

/**
 * PS-206: bounded per-carrier quoting — one slow/hung provider becomes a
 * per-carrier 'failed' diagnostic (with this reason) instead of holding the
 * whole combined response open. Pure (caller supplies the promise), so the
 * timeout rule is offline-testable without any provider call.
 */
export const DIRECT_CARRIER_QUOTE_TIMEOUT_MS = 25_000;

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
  const combinedRates = dedupeBrowseRates([...input.ssRates, ...input.directRates]);
  const directCarrierIds = [
    ...new Set(input.directDiagnostics.map((diagnostic) => diagnostic.carrierId).filter(Boolean)),
  ];
  const combinedRequestKey = directCarrierIds.length
    ? `${input.ssCacheKey}:direct:${directCarrierIds.sort().join(',')}`
    : input.ssCacheKey;
  // The SINGLE pick, on the uniform charge basis (both families carry the same
  // markup rules by the time they reach this module).
  const cheapest = [...combinedRates].sort((a, b) => rateTotal(a) - rateTotal(b))[0] ?? null;

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
      carrierName: input.accountNamesByCarrierId.get(id) ?? diagnostic?.nickname ?? id,
      carrierCode: diagnostic?.carrierCode,
      nickname: diagnostic?.nickname,
      status,
      rateCount: hasRates ? combinedRates.filter((rate) => rate.carrier_id === id).length : diagnostic?.rateCount ?? 0,
      durationMs: diagnostic?.durationMs,
      error: diagnostic?.error,
    };
  });
  const directCarrierStatuses: BestRateWorkflowCarrierStatus[] = input.directDiagnostics.map((diagnostic) => ({
    carrierId: diagnostic.carrierId,
    carrierName: diagnostic.nickname ?? diagnostic.carrierId,
    carrierCode: diagnostic.carrierCode,
    nickname: diagnostic.nickname,
    status:
      diagnostic.status === 'ok'
        ? 'live'
        : diagnostic.status === 'failed'
          ? 'error'
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
    error: diagnostic.error,
  }));
  const combinedCarrierStatuses = [...carrierStatuses, ...directCarrierStatuses];
  const directCarrierDiagnostics: Array<Record<string, unknown>> = input.directDiagnostics.map(
    (diagnostic) => ({ ...diagnostic, source: 'direct' }),
  );
  const combinedCarrierDiagnostics: Array<Record<string, unknown>> = [
    ...input.ssDiagnostics.map((diagnostic) => ({ ...diagnostic, source: 'shipstation' })),
    ...directCarrierDiagnostics,
  ];

  return {
    combinedRates,
    cheapest,
    combinedRequestKey,
    carrierStatuses,
    directCarrierStatuses,
    combinedCarrierStatuses,
    directCarrierDiagnostics,
    combinedCarrierDiagnostics,
    bestRateComplete: statusesComplete(combinedCarrierStatuses),
  };
}
