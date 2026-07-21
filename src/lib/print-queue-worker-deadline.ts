export const PRINT_QUEUE_WORKER_HANDLER_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.PRINT_QUEUE_WORKER_JOB_TIMEOUT_MS) || 10 * 60_000,
);

export const PRINT_QUEUE_MERGE_HEARTBEAT_INTERVAL_MS = 15_000;
export const PRINT_QUEUE_MERGE_HEARTBEAT_STALE_MS = 60_000;

// A running generation remains live through its configured deadline plus a
// short window for cancellation acknowledgement and terminal persistence.
export const PRINT_QUEUE_WORKER_RUNNING_LEASE_MS =
  PRINT_QUEUE_WORKER_HANDLER_TIMEOUT_MS + 30_000;
