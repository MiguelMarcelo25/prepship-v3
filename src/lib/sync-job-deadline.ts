export const SYNC_JOB_HANDLER_TIMEOUT_MS = Math.max(
  60_000,
  Math.min(25 * 60_000, Number(process.env.JOB_HANDLER_TIMEOUT_MS) || 10 * 60_000),
);

// Small grace covers final status persistence after the handler deadline fires.
export const SYNC_JOB_RUNNING_LEASE_MS = SYNC_JOB_HANDLER_TIMEOUT_MS + 30_000;

// PS-436: after the handler deadline, cooperative work gets a short window to
// acknowledge AbortSignal cancellation. The shared advisory lane remains held
// during this grace. If the promise still has not settled, the worker exits
// instead of releasing a zombie generation into the next sync attempt.
export const SYNC_JOB_CANCELLATION_GRACE_MS = Math.max(
  1_000,
  Math.min(
    30_000,
    Number(process.env.JOB_CANCELLATION_GRACE_MS) || 5_000,
  ),
);
