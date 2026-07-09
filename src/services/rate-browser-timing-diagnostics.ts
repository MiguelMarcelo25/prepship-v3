export type RateBrowseTimingStatus =
  | 'cached'
  | 'live'
  | 'unavailable'
  | 'error'
  | 'timeout'
  | 'uncached'
  | 'loading';

export type RateBrowseProviderOutcome =
  | 'ok'
  | 'empty'
  | 'cached'
  | 'uncached'
  | 'failed'
  | 'timeout'
  | 'skipped'
  | 'loading';

export type RateBrowseTimingCarrier = {
  carrierId: string;
  accountId?: string;
  carrierName?: string;
  carrierCode?: string;
  source: 'shipstation' | 'direct' | 'unknown';
  status: RateBrowseTimingStatus;
  outcome: RateBrowseProviderOutcome;
  rateCount: number;
  durationMs?: number;
  limiterWaitMs?: number;
  attempts?: number;
  retryable?: boolean;
  error?: string;
};

export type RateBrowseFailureDiagnostic = {
  code: 'all_rate_providers_failed';
  message: string;
  providers: Array<{
    carrierId: string;
    name: string;
    source: RateBrowseTimingCarrier['source'];
    outcome: Extract<RateBrowseProviderOutcome, 'failed' | 'timeout'>;
  }>;
};

export type RateBrowseTimingDiagnostics = {
  totalDurationMs: number;
  shipStationDurationMs: number;
  directCarrierDurationMs: number;
  carriers: RateBrowseTimingCarrier[];
  rateEngineLimiter?: {
    limiterBefore: Record<string, unknown>;
    limiterAfter: Record<string, unknown>;
  };
};

function durationMs(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function safeText(value: unknown, maxLength = 80): string | undefined {
  const normalized = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

export function sanitizeRateProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'Carrier rate request failed');
  const lower = raw.toLowerCase();
  if (/timed out|timeout|etimedout|esockettimedout/.test(lower)) return 'Carrier rate request timed out';
  if (/\b429\b|too many requests|rate limit/.test(lower)) return 'Carrier rate limit reached; retry shortly';
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid credentials|access denied/.test(lower)) {
    return 'Carrier account authorization failed';
  }
  if (/\b5\d\d\b|service unavailable|bad gateway|gateway timeout/.test(lower)) {
    return 'Carrier service temporarily unavailable';
  }
  if (/econnreset|socket hang up|network error|fetch failed|eai_again/.test(lower)) {
    return 'Carrier network request failed';
  }
  if (/no service|not available|unsupported/.test(lower)) return 'No eligible carrier service returned';
  return 'Carrier rate request failed';
}

function elapsedMs(startedAtMs: number, completedAtMs: number): number {
  const elapsed = completedAtMs - startedAtMs;
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : 0;
}

export function normalizeRateBrowseTimingStatus(
  status: unknown,
  error?: unknown,
): RateBrowseTimingStatus {
  const text = String(status ?? '').trim().toLowerCase();
  const errorText = String(error ?? '').trim().toLowerCase();
  if (/timed out|timeout/.test(errorText)) return 'timeout';
  if (text === 'ok' || text === 'live') return 'live';
  if (text === 'empty' || text === 'unavailable') return 'unavailable';
  if (text === 'cached') return 'cached';
  if (text === 'uncached') return 'uncached';
  if (text === 'loading') return 'loading';
  return 'error';
}

export function normalizeRateBrowseProviderOutcome(
  status: unknown,
  error?: unknown,
): RateBrowseProviderOutcome {
  const text = String(status ?? '').trim().toLowerCase();
  const errorText = String(error ?? '').trim().toLowerCase();
  if (/timed out|timeout/.test(errorText)) return 'timeout';
  if (text === 'ok' || text === 'live') return 'ok';
  if (text === 'empty' || text === 'unavailable') return 'empty';
  if (text === 'cached') return 'cached';
  if (text === 'uncached') return 'uncached';
  if (text === 'skipped' || text === 'blocked') return 'skipped';
  if (text === 'loading' || text === 'pending' || text === 'queued') return 'loading';
  return 'failed';
}

export function buildRateBrowseFailureDiagnostic(input: {
  ratesCount: number;
  carriers: RateBrowseTimingCarrier[];
}): RateBrowseFailureDiagnostic | null {
  if (input.ratesCount > 0 || input.carriers.length === 0) return null;
  const failed = input.carriers.filter(
    (carrier): carrier is RateBrowseTimingCarrier & { outcome: 'failed' | 'timeout' } =>
      carrier.outcome === 'failed' || carrier.outcome === 'timeout',
  );
  if (failed.length !== input.carriers.length) return null;
  const providers = failed.map((carrier) => ({
    carrierId: carrier.carrierId,
    name: safeText(carrier.carrierName ?? carrier.carrierCode ?? carrier.carrierId) ?? carrier.carrierId,
    source: carrier.source,
    outcome: carrier.outcome,
  }));
  const summary = providers
    .slice(0, 4)
    .map((provider) => `${provider.name} (${provider.outcome})`)
    .join(', ');
  const remainder = providers.length > 4 ? ` and ${providers.length - 4} more` : '';
  return {
    code: 'all_rate_providers_failed',
    message: `No rates returned. Slow or failed accounts: ${summary}${remainder}. Retry Browse Rates; check the named carrier accounts if the failure continues.`,
    providers,
  };
}

export function buildRateBrowseTimingDiagnostics(input: {
  startedAtMs: number;
  completedAtMs: number;
  shipStationDurationMs: number;
  directCarrierDurationMs: number;
  carrierDiagnostics: Array<Record<string, unknown>>;
  rateEngineLimiter?: {
    limiterBefore: Record<string, unknown>;
    limiterAfter: Record<string, unknown>;
  };
}): RateBrowseTimingDiagnostics {
  return {
    totalDurationMs: elapsedMs(input.startedAtMs, input.completedAtMs),
    shipStationDurationMs: elapsedMs(0, input.shipStationDurationMs),
    directCarrierDurationMs: elapsedMs(0, input.directCarrierDurationMs),
    ...(input.rateEngineLimiter ? { rateEngineLimiter: input.rateEngineLimiter } : {}),
    carriers: input.carrierDiagnostics
      .map((diagnostic): RateBrowseTimingCarrier | null => {
        const carrierId = String(diagnostic.carrierId ?? '').trim();
        if (!carrierId) return null;
        const source =
          diagnostic.source === 'shipstation' || diagnostic.source === 'direct'
            ? diagnostic.source
            : 'unknown';
        const rateCount = Number(diagnostic.rateCount ?? 0);
        const error = typeof diagnostic.error === 'string' ? diagnostic.error : undefined;
        const carrier: RateBrowseTimingCarrier = {
          carrierId,
          accountId: safeText(diagnostic.accountId),
          carrierName: typeof diagnostic.nickname === 'string' ? diagnostic.nickname : undefined,
          carrierCode: typeof diagnostic.carrierCode === 'string' ? diagnostic.carrierCode : undefined,
          source,
          status: normalizeRateBrowseTimingStatus(diagnostic.status, error),
          outcome: normalizeRateBrowseProviderOutcome(diagnostic.status, error),
          rateCount: Number.isFinite(rateCount) && rateCount >= 0 ? Math.round(rateCount) : 0,
        };
        const carrierDurationMs = durationMs(diagnostic.durationMs);
        if (carrierDurationMs != null) carrier.durationMs = carrierDurationMs;
        const limiterWaitMs = durationMs(diagnostic.limiterWaitMs);
        if (limiterWaitMs != null) carrier.limiterWaitMs = limiterWaitMs;
        const attempts = positiveInteger(diagnostic.attempts);
        if (attempts != null) carrier.attempts = attempts;
        if (typeof diagnostic.retryable === 'boolean') carrier.retryable = diagnostic.retryable;
        if (error) carrier.error = sanitizeRateProviderError(error);
        return carrier;
      })
      .filter((carrier): carrier is RateBrowseTimingCarrier => Boolean(carrier)),
  };
}
