export type WorkerFailureKind = 'unhandled_rejection' | 'uncaught_exception';

export type WorkerFailureSnapshot = {
  kind: WorkerFailureKind;
  failureCount: number;
  failureLimit: number;
  exitRequested: boolean;
};

/**
 * Worker process-lifecycle owner for failures that escape normal job
 * boundaries. The supervisor is the recovery owner after the bounded limit.
 */
export function createWorkerFailureBreaker(
  failureLimit: number,
  exit: (code: number) => void = (code) => process.exit(code),
): (kind: WorkerFailureKind) => WorkerFailureSnapshot {
  const normalizedLimit = Math.max(1, Math.trunc(failureLimit));
  let failureCount = 0;
  let exitRequested = false;

  return (kind) => {
    failureCount += 1;
    if (!exitRequested && failureCount >= normalizedLimit) {
      exitRequested = true;
      exit(1);
    }
    return {
      kind,
      failureCount,
      failureLimit: normalizedLimit,
      exitRequested,
    };
  };
}
