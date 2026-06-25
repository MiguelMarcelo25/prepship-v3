/**
 * carrier-estimate-retry.ts — bounded retry for a TRANSIENT per-carrier rate-estimate failure
 * (RC1, the "Rate unavailable" root cause).
 *
 * ShipStation's /v2/rates/estimate intermittently answers slower than the per-carrier cap (observed
 * 11–16s+ against a 25s cap), and fetchEstimateForCarrier's catch swallows that into status:'failed'
 * with NO retry — so one transient slow response permanently loses that carrier's rate for the order
 * (the run-to-run "some rows rate, some don't" inconsistency for the same client/weight). This module
 * classifies a caught error as TRANSIENT (timeout / 429 / 5xx / network) vs TERMINAL (4xx / no-service)
 * and provides a pure, injectable retry loop. A terminal error is NEVER retried — a real "no service"
 * must surface immediately.
 *
 * Pure + dependency-injected (sleep + jitter) so the resilience contract is verified offline by
 * scripts/ps-rate-estimate-retry-guard.ts with no network or DB.
 */

export const RATE_ESTIMATE_MAX_RETRIES = Math.max(
  0,
  Number.parseInt(process.env.RATE_ESTIMATE_MAX_RETRIES ?? '1', 10) || 1,
);
export const RATE_ESTIMATE_RETRY_BASE_MS = Math.max(
  0,
  Number.parseInt(process.env.RATE_ESTIMATE_RETRY_BASE_MS ?? '350', 10) || 350,
);

function readStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const s = (err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' && Number.isFinite(s) ? s : null;
}

/**
 * True for a TRANSIENT carrier rate error worth retrying: a timeout, HTTP 429, any 5xx, or a network
 * blip. An explicit 4xx other than 429 is TERMINAL (validation / no-service) and returns false.
 */
export function isTransientCarrierRateError(err: unknown): boolean {
  if (err == null) return false;
  const status = readStatus(err);
  if (status != null) {
    if (status === 429 || status >= 500) return true;
    if (status >= 400) return false; // terminal client error (validation / no-service)
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/timed out|timeout/.test(msg)) return true;
  if (/\b429\b|\b5\d\d\b|too many requests|rate limit|service unavailable|bad gateway|gateway timeout/.test(msg)) {
    return true;
  }
  if (/econnreset|etimedout|esockettimedout|socket hang up|network error|fetch failed|eai_again/.test(msg)) {
    return true;
  }
  return false;
}

export type TransientRetryOpts = {
  maxRetries: number;
  baseDelayMs: number;
  /** Injectable for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to jittered. */
  jitter?: () => number;
};

/**
 * Run `attempt`; while its result `isRetryable` and attempts remain, back off (baseDelay * n + jitter)
 * and re-run `attempt` from scratch. The caller re-acquires its limiter slot INSIDE `attempt`, so a
 * retry respects the rate budget and never holds a concurrency slot during the backoff. Returns the
 * last result (success, terminal failure, or the final exhausted-transient failure).
 */
export async function runWithTransientRetry<T>(
  attempt: () => Promise<T>,
  isRetryable: (result: T) => boolean,
  opts: TransientRetryOpts,
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const jitter = opts.jitter ?? (() => Math.floor(Math.random() * (opts.baseDelayMs || 1)));
  const maxRetries = Math.max(0, opts.maxRetries);
  let result = await attempt();
  for (let n = 1; n <= maxRetries && isRetryable(result); n += 1) {
    await sleep(opts.baseDelayMs * n + jitter());
    result = await attempt();
  }
  return result;
}
