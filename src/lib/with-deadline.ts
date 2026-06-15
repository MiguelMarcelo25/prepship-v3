/**
 * PS-265 — bound a unit of async work with a deadline.
 *
 * Races work() against a timer. If work() doesn't settle within `ms`, the returned
 * promise REJECTS with DeadlineExceededError; the timer is always cleared. Note:
 * this does NOT cancel the underlying work (JS can't), it just stops AWAITING it —
 * which is the point: a hung background job handler must not hold an in-process
 * mutex (sync-job-queue's activeJobName) forever. On rejection the caller's
 * catch/finally runs, the mutex releases, and the next job can proceed. The
 * underlying hang is addressed separately by per-request HTTP timeouts.
 */
export class DeadlineExceededError extends Error {
  constructor(public readonly label: string, public readonly ms: number) {
    super(`${label} exceeded its ${ms}ms deadline`);
    this.name = 'DeadlineExceededError';
  }
}

export async function withDeadline<T>(
  work: () => Promise<T> | T,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(label, ms)), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
