export const SYNC_JOB_HANDLER_TIMEOUT_MS = Math.max(
  60_000,
  Math.min(25 * 60_000, Number(process.env.JOB_HANDLER_TIMEOUT_MS) || 10 * 60_000),
);

// Small grace covers final status persistence after the handler deadline fires.
export const SYNC_JOB_RUNNING_LEASE_MS = SYNC_JOB_HANDLER_TIMEOUT_MS + 30_000;
