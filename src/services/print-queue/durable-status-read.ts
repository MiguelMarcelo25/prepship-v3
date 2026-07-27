const DURABLE_STATUS_TIMEOUT = Symbol('durable-status-timeout');

export type DurableStatusRead<T> = {
  value: T | null;
  timedOut: boolean;
  /** Wall time spent waiting, so callers can log why they gave up. */
  elapsedMs: number;
};

export type DurableStatusReadOptions = {
  /** Identifies the read in late-settlement logs (e.g. the job id). */
  label?: string;
  /** How long to keep watching an abandoned read before giving up on it. */
  lateObservationMs?: number;
};

const DEFAULT_LATE_OBSERVATION_MS = 30_000;

/**
 * Per user override unlock shipped data on 2026-07-14 (Audit PQ-10): preserve
 * absent-versus-slow status reads without mutating queue/order/shipment state.
 *
 * Instrumented 2026-07-27. This helper previously discarded the only evidence
 * that mattered: on timeout it reported "timed out" and dropped the in-flight
 * read, so a 1500ms budget overrun was indistinguishable from a read that
 * would have finished at 1501ms or one that never returned at all. Repeated
 * 503s on /print-queue/batch-send/status/:jobId could not be explained,
 * despite the underlying queries measuring under 0.4ms and the database
 * sitting idle.
 *
 * The abandoned read is now still observed. When it eventually settles the
 * outcome is logged with its true duration, which distinguishes:
 *   - a marginally slow read (settles just over budget)
 *   - a blocked read (settles far over budget, e.g. connection acquisition)
 *   - a hung read (never settles within the observation window)
 *
 * Observation is passive: the result is not used, no state is written, and the
 * caller's behaviour is unchanged. It only makes the next occurrence
 * self-explaining.
 */
export async function readDurableStatusWithTimeout<T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
  options: DurableStatusReadOptions = {},
): Promise<DurableStatusRead<T>> {
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | null = null;
  // Held so the read can still be observed after the race is abandoned.
  const pending = read();

  try {
    const value = await Promise.race([
      pending,
      new Promise<typeof DURABLE_STATUS_TIMEOUT>((resolve) => {
        timeout = setTimeout(() => resolve(DURABLE_STATUS_TIMEOUT), timeoutMs);
      }),
    ]);
    const elapsedMs = Date.now() - startedAt;
    if (value === DURABLE_STATUS_TIMEOUT) {
      observeAbandonedRead(pending, startedAt, timeoutMs, options);
      return { value: null, timedOut: true, elapsedMs };
    }
    return { value, timedOut: false, elapsedMs };
  } catch (error) {
    // A rejecting read is a failure, not a timeout; preserve the existing
    // absent-versus-slow contract rather than reporting a false timeout.
    const elapsedMs = Date.now() - startedAt;
    console.warn(
      '[durable-status-read] read failed'
      + ` label=${options.label ?? 'unknown'} elapsedMs=${elapsedMs}`
      + ` error=${error instanceof Error ? error.message : String(error)}`,
    );
    return { value: null, timedOut: false, elapsedMs };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Watches a read the caller has already given up on and reports how it ends.
 * Never rethrows -- an abandoned read must not surface as an unhandled
 * rejection on a request that has already been answered.
 */
function observeAbandonedRead(
  pending: Promise<unknown>,
  startedAt: number,
  timeoutMs: number,
  options: DurableStatusReadOptions,
): void {
  const label = options.label ?? 'unknown';
  const observationMs = options.lateObservationMs ?? DEFAULT_LATE_OBSERVATION_MS;
  let settled = false;

  const giveUp = setTimeout(() => {
    if (settled) return;
    console.warn(
      '[durable-status-read] abandoned read never settled'
      + ` label=${label} budgetMs=${timeoutMs} observedMs=${observationMs}`,
    );
  }, observationMs);
  // Do not hold the process open just to finish observing.
  if (typeof giveUp.unref === 'function') giveUp.unref();

  const report = (outcome: string, detail?: string) => {
    settled = true;
    clearTimeout(giveUp);
    const elapsedMs = Date.now() - startedAt;
    console.warn(
      `[durable-status-read] abandoned read ${outcome}`
      + ` label=${label} budgetMs=${timeoutMs} actualMs=${elapsedMs}`
      + ` overBudgetMs=${elapsedMs - timeoutMs}${detail ? ` ${detail}` : ''}`,
    );
  };

  pending.then(
    (value) => report(value == null ? 'settled empty' : 'settled with a row'),
    (error) => report('rejected', `error=${error instanceof Error ? error.message : String(error)}`),
  );
}
