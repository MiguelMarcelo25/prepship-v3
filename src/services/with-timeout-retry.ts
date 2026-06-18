// Bounded timeout + retry-on-timeout for the rate-backfill's per-order rate fetch.
//
// WHY (recalculate "fix recalculate logic" / Trello #750): "Recalculate All" (maxAgeHours 0) re-rates
// EVERY awaiting order with forceRefresh (no cache), so each order's carrier fan-out queues behind the
// global rate limiter (RATE_FETCH_CONCURRENCY). The backfill's per-order timeout wrapped that QUEUE
// WAIT, so a 40+ order burst made most orders time out while merely waiting for a permit — not because
// any fetch was broken (every failure sample was literally "getRates(...) timed out after 30000ms",
// 37/43 orders). This wrapper (a) times out a genuinely hung fetch and (b) retries a TIMED-OUT attempt a
// bounded number of times; by the retry the initial burst has drained, so the order gets its rate. A
// non-timeout error is NOT retried — a real rate error should surface immediately. Pure + injectable
// (operation passed in) so the resilience contract is verified offline by the guard.

export const RATE_FETCH_TIMEOUT_CODE = 'RATE_FETCH_TIMEOUT';

export class TimeoutError extends Error {
  readonly code = RATE_FETCH_TIMEOUT_CODE;
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** True for a timeout produced by withTimeout (or any error carrying the timeout code). */
export function isTimeoutError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === RATE_FETCH_TIMEOUT_CODE;
}

/** Reject with a coded TimeoutError if `p` does not settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (err) => { clearTimeout(t); reject(err); },
    );
  });
}

/**
 * Run `operation` under `timeoutMs`, retrying ONLY on timeout up to `maxRetries` times. Non-timeout
 * rejections propagate on the first attempt (no retry). `operation` receives the 0-based attempt index.
 */
export async function runWithTimeoutAndRetry<T>(
  operation: (attempt: number) => Promise<T>,
  opts: { timeoutMs: number; maxRetries: number; label: string },
): Promise<T> {
  const maxRetries = Math.max(0, opts.maxRetries);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTimeout(operation(attempt), opts.timeoutMs, opts.label);
    } catch (err) {
      if (!isTimeoutError(err) || attempt >= maxRetries) throw err;
    }
  }
}
