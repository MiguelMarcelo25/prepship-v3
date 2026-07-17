export type CancellationAcknowledgement =
  | { acknowledged: true }
  | { acknowledged: false };

function cancellationReason(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${label} aborted`);
}

/**
 * Await the real operation instead of racing it against AbortSignal. This is
 * intentional: a wrapper rejection is not cancellation acknowledgement while
 * the DB/provider promise can still run. Cooperative operations receive the
 * signal separately; non-cooperative work keeps the lane fenced and lets the
 * queue owner terminate the worker after its grace period.
 */
export async function awaitSettledWork<T>(
  work: PromiseLike<T>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  if (signal?.aborted) throw cancellationReason(signal, label);
  try {
    const result = await work;
    if (signal?.aborted) throw cancellationReason(signal, label);
    return result;
  } catch (error) {
    if (signal?.aborted) throw cancellationReason(signal, label);
    throw error;
  }
}

/**
 * Wait only for the bounded post-abort grace period. This never detaches or
 * releases a lane itself; the queue owner decides whether to continue or
 * terminate the worker while its cross-process advisory fence is still held.
 */
export async function awaitCancellationAcknowledgement(
  work: Promise<unknown>,
  graceMs: number,
): Promise<CancellationAcknowledgement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then<CancellationAcknowledgement, CancellationAcknowledgement>(
        () => ({ acknowledged: true }),
        () => ({ acknowledged: true }),
      ),
      new Promise<CancellationAcknowledgement>((resolve) => {
        timer = setTimeout(() => resolve({ acknowledged: false }), graceMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Canonical fail-closed cancellation decision. The caller supplies the status
 * closeout and hard terminator so tests can prove the decision without exiting
 * their own process.
 */
export async function requireCancellationAcknowledgement(input: {
  work: Promise<unknown>;
  graceMs: number;
  beforeTerminate?: () => Promise<void>;
  terminate: () => never;
}): Promise<void> {
  const cancellation = await awaitCancellationAcknowledgement(
    input.work,
    input.graceMs,
  );
  if (cancellation.acknowledged) return;
  await input.beforeTerminate?.();
  input.terminate();
}

/**
 * Fail closed while the caller still owns the shared advisory lane. A hard
 * process exit is the only safe recovery for a promise that ignored abort:
 * returning would release the lane and permit a successor to overlap it.
 */
export function terminateWorkerForUnacknowledgedCancellation(input: {
  jobName: string;
  jobId: string;
  graceMs: number;
}): never {
  console.error(
    `[job-queue] ${input.jobName} (${input.jobId}) ignored cancellation for ${input.graceMs}ms; `
      + 'terminating worker while the sync lane is fenced',
  );
  process.exit(1);
}
