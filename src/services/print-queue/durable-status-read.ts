const DURABLE_STATUS_TIMEOUT = Symbol('durable-status-timeout');

export type DurableStatusRead<T> = {
  value: T | null;
  timedOut: boolean;
};

/**
 * Per user override unlock shipped data on 2026-07-14 (Audit PQ-10): preserve
 * absent-versus-slow status reads without mutating queue/order/shipment state.
 */
export async function readDurableStatusWithTimeout<T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
): Promise<DurableStatusRead<T>> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    const value = await Promise.race([
      read(),
      new Promise<typeof DURABLE_STATUS_TIMEOUT>((resolve) => {
        timeout = setTimeout(() => resolve(DURABLE_STATUS_TIMEOUT), timeoutMs);
      }),
    ]);
    return value === DURABLE_STATUS_TIMEOUT
      ? { value: null, timedOut: true }
      : { value, timedOut: false };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
