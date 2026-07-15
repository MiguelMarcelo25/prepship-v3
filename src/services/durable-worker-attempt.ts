import { DeadlineExceededError, withDeadline } from '../lib/with-deadline';

export type DurableWorkerAttemptHooks = {
  heartbeat: () => Promise<boolean>;
  requestCancellation: () => Promise<void>;
  acknowledgeCancellation: () => Promise<void>;
};

export type DurableWorkerAttemptResult<T> = {
  value: T;
  timedOut: boolean;
};

/**
 * Run one durable worker generation without releasing its queue claim while
 * non-cooperative work is still live. A timeout requests cooperative abort,
 * then waits for the original promise to settle before acknowledging the
 * cancellation. The caller still owns generation-conditional persistence.
 */
export async function runDurableWorkerAttempt<T>(input: {
  label: string;
  timeoutMs: number;
  heartbeatIntervalMs: number;
  execute: (signal: AbortSignal) => Promise<T>;
  hooks: DurableWorkerAttemptHooks;
}): Promise<DurableWorkerAttemptResult<T>> {
  const controller = new AbortController();
  let heartbeatFailure: Error | null = null;
  const heartbeatTimer = setInterval(() => {
    void input.hooks.heartbeat().then((current) => {
      if (!current && !heartbeatFailure) {
        heartbeatFailure = new Error(`${input.label} lost its durable generation fence`);
        controller.abort(heartbeatFailure);
      }
    }).catch((error) => {
      if (!heartbeatFailure) {
        heartbeatFailure = error instanceof Error ? error : new Error(String(error));
        controller.abort(heartbeatFailure);
      }
    });
  }, Math.max(1, input.heartbeatIntervalMs));
  heartbeatTimer.unref?.();

  const workPromise = Promise.resolve().then(() => input.execute(controller.signal));
  let timedOut = false;
  try {
    try {
      const value = await withDeadline(
        () => workPromise,
        input.timeoutMs,
        input.label,
        {
          onTimeout: (error) => {
            timedOut = true;
            controller.abort(error);
          },
        },
      );
      if (heartbeatFailure) throw heartbeatFailure;
      return { value, timedOut: false };
    } catch (error) {
      if (!(error instanceof DeadlineExceededError)) throw error;
      timedOut = true;
      await input.hooks.requestCancellation();
      // Do not release the pg-boss/advisory claim while an old generation can
      // still write. Cooperative handlers stop quickly; non-cooperative ones
      // must settle before a retry can start.
      const value = await workPromise;
      if (heartbeatFailure) throw heartbeatFailure;
      return { value, timedOut: true };
    }
  } finally {
    clearInterval(heartbeatTimer);
    if (timedOut) await input.hooks.acknowledgeCancellation();
  }
}
