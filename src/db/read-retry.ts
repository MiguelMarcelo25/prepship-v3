import { classifyMainPoolFailure } from '../services/main-pool-health.js';

/**
 * Retry a READ-ONLY database operation across a dropped connection.
 *
 * Why this exists, and why it is not a general retry:
 *
 * postgres.js already reconnects — `closed()` calls `reconnect()` with a backoff
 * of `min(3^retries/100, 20)` seconds and resets the counter on any successful
 * connect (node_modules/postgres/src/connection.js). The pool heals itself
 * within ~20s worst case. What it does NOT do is rescue the query that was in
 * flight when the socket died: that one rejects with CONNECTION_CLOSED and the
 * user sees a 500, even though the very next request would have succeeded.
 *
 * That is the whole gap this closes. During the 2026-08-11 pooler incidents the
 * Orders page failed on exactly this class of error.
 *
 * ⚠ READS ONLY. Never wrap an INSERT/UPDATE/DELETE, a transaction, or a label
 * purchase. CONNECTION_CLOSED is ambiguous for a write: the statement may have
 * committed server-side and only the response was lost. Retrying that duplicates
 * the effect — a second charge, a second label, a second ledger movement. A read
 * has no such ambiguity, which is the only reason retrying is safe here.
 *
 * Only `unreachable` errors retry (socket gone). A saturated pool is deliberately
 * NOT retried: piling more attempts onto a pool that has no free connection makes
 * the contention worse, and the caller's timeout is the right backpressure.
 */

export type DbReadRetryOptions = {
  /** Total attempts including the first. Default 2 — one retry. */
  attempts?: number;
  /** Pause before each retry. Default 50ms — enough for postgres.js to swap in a fresh socket. */
  delayMs?: number;
  /** Observability hook; must not throw. */
  onRetry?: (attempt: number, error: unknown) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withDbReadRetry<T>(
  read: () => Promise<T>,
  options: DbReadRetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 2));
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? 50));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === attempts;
      // A saturated pool falls through here too, and is intentionally not retried.
      if (isLastAttempt || classifyMainPoolFailure(error) !== 'unreachable') {
        throw error;
      }
      try {
        options.onRetry?.(attempt, error);
      } catch {
        // Observability must never convert a recoverable read into a failure.
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastError;
}
