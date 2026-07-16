export type CancellationAcknowledgement =
  | { acknowledged: true }
  | { acknowledged: false };

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
