export type RateBrowseTimingStatus =
  | 'cached'
  | 'live'
  | 'unavailable'
  | 'error'
  | 'timeout'
  | 'uncached'
  | 'loading';

export type RateBrowseTimingCarrier = {
  carrierId: string;
  carrierName?: string;
  carrierCode?: string;
  source: 'shipstation' | 'direct' | 'unknown';
  status: RateBrowseTimingStatus;
  rateCount: number;
  durationMs?: number;
  error?: string;
};

export type RateBrowseTimingDiagnostics = {
  totalDurationMs: number;
  shipStationDurationMs: number;
  directCarrierDurationMs: number;
  carriers: RateBrowseTimingCarrier[];
};

function durationMs(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
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

export function buildRateBrowseTimingDiagnostics(input: {
  startedAtMs: number;
  completedAtMs: number;
  shipStationDurationMs: number;
  directCarrierDurationMs: number;
  carrierDiagnostics: Array<Record<string, unknown>>;
}): RateBrowseTimingDiagnostics {
  return {
    totalDurationMs: elapsedMs(input.startedAtMs, input.completedAtMs),
    shipStationDurationMs: elapsedMs(0, input.shipStationDurationMs),
    directCarrierDurationMs: elapsedMs(0, input.directCarrierDurationMs),
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
          carrierName: typeof diagnostic.nickname === 'string' ? diagnostic.nickname : undefined,
          carrierCode: typeof diagnostic.carrierCode === 'string' ? diagnostic.carrierCode : undefined,
          source,
          status: normalizeRateBrowseTimingStatus(diagnostic.status, error),
          rateCount: Number.isFinite(rateCount) && rateCount >= 0 ? Math.round(rateCount) : 0,
        };
        const carrierDurationMs = durationMs(diagnostic.durationMs);
        if (carrierDurationMs != null) carrier.durationMs = carrierDurationMs;
        if (error) carrier.error = error;
        return carrier;
      })
      .filter((carrier): carrier is RateBrowseTimingCarrier => Boolean(carrier)),
  };
}
