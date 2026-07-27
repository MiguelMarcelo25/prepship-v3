/**
 * Retry policy for the batch-send status poll.
 *
 * The backend answers a slow durable-snapshot read with HTTP 503 and
 * `{ code: 'PRINT_QUEUE_STATUS_UNAVAILABLE', retryable: true }`. It says so
 * deliberately: a slow read is temporary infrastructure trouble, not evidence
 * the job is absent. The poll loop used to let that throw, which killed the
 * loop and reported a failed send while the job was still running and would
 * usually finish on its own.
 *
 * This only decides whether to keep waiting. It never invents job state --
 * the backend remains the sole authority on whether a send succeeded.
 */

/** Attempts tolerated before the failure is treated as real. */
export const QUEUE_STATUS_RETRY_LIMIT = 5;

/** Base backoff; the caller multiplies by the consecutive-failure count. */
export const QUEUE_STATUS_RETRY_DELAY_MS = 1000;

const RETRYABLE_CODES = new Set(['PRINT_QUEUE_STATUS_UNAVAILABLE']);

/**
 * True only when the backend flagged this failure as survivable, either by
 * its typed code or by the explicit `retryable` field. Anything else — a 404,
 * a scope rejection, a genuine job failure — is passed through untouched.
 */
export function isRetryableQueueStatusError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; retryable?: unknown; status?: unknown };
  if (candidate.retryable === true) return true;
  if (typeof candidate.code === 'string' && RETRYABLE_CODES.has(candidate.code)) return true;
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
