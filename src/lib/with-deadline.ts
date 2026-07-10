/**
 * PS-265 — bound a unit of async work with a deadline.
 *
 * Races work() against a timer. If work() doesn't settle within `ms`, the returned
 * promise REJECTS with DeadlineExceededError; the timer is always cleared.
 * Callers may use onTimeout for cooperative cancellation of underlying work.
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
  options: { onTimeout?: (error: DeadlineExceededError) => void } = {},
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineExceededError(label, ms);
      try {
        options.onTimeout?.(error);
      } catch {
        // Deadline remains authoritative if cooperative cancellation fails.
      }
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
