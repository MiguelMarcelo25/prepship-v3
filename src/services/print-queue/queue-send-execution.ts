// Per user override unlock shipped data on 2026-07-14: execution controls only.
// This module never buys postage or mutates orders/shipments; it prevents a
// timed-out parent job from admitting more work or re-entering concurrently.
export class QueueSendJobInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueSendJobInterruptedError';
  }
}

// Per user override unlock shipped data on 2026-07-21: PS-452 keeps each
// postage-capable worker chunk inside the 10-minute cooperative deadline even
// when four lanes each consume the provider's 90-second timeout budget.
export const QUEUE_SEND_EXECUTION_CHUNK_SIZE = 20;
export const QUEUE_SEND_MAX_ITEM_ATTEMPTS = 3;
export const QUEUE_SEND_MAX_PARENT_GENERATIONS = 30;
export const QUEUE_SEND_HEARTBEAT_INTERVAL_MS = 15_000;

export type QueueSendLocalTailState = 'receipt_resume' | 'shipment_persisted';

export function queueSendLocalTailFailureState(
  state: string | null | undefined,
  attemptCount: number,
  maxAttempts = QUEUE_SEND_MAX_ITEM_ATTEMPTS,
): QueueSendLocalTailState | 'failed_terminal' | null {
  if (state !== 'receipt_resume' && state !== 'shipment_persisted') return null;
  return attemptCount < maxAttempts ? state : 'failed_terminal';
}

export function planQueueSendWorkerChunks<T>(
  items: T[],
  chunkSize = QUEUE_SEND_EXECUTION_CHUNK_SIZE,
): T[][] {
  const safeSize = Math.max(
    1,
    Math.min(QUEUE_SEND_EXECUTION_CHUNK_SIZE, Math.floor(chunkSize)),
  );
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += safeSize) {
    chunks.push(items.slice(start, start + safeSize));
  }
  return chunks;
}

export async function runQueueSendPool<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  maxConcurrent: number,
  signal?: AbortSignal,
): Promise<void> {
  const queue = [...items];
  const running = new Set<Promise<void>>();
  const concurrency = Math.max(1, Math.floor(maxConcurrent));
  let firstError: unknown;
  while (queue.length > 0 || running.size > 0) {
    while (
      !signal?.aborted
      && firstError === undefined
      && running.size < concurrency
      && queue.length > 0
    ) {
      const item = queue.shift();
      if (item !== undefined) {
        // Capture the first failure without letting Promise.race reject early.
        // Already-admitted provider work must settle before the worker releases
        // its durable claim, otherwise a recovery generation could overlap it.
        const task = Promise.resolve()
          .then(() => fn(item))
          .catch((error: unknown) => {
            if (firstError === undefined) firstError = error;
          })
          .finally(() => running.delete(task));
        running.add(task);
      }
    }
    if (running.size > 0) await Promise.race(running);
    if ((signal?.aborted || firstError !== undefined) && running.size === 0) break;
  }
  if (firstError !== undefined) throw firstError;
  if (queue.length > 0) {
    throw new QueueSendJobInterruptedError(
      `Queue send interrupted with ${queue.length} order${queue.length === 1 ? '' : 's'} not started`,
    );
  }
}

const activeRuns = new Map<string, Promise<unknown>>();

export async function runQueueSendSingleFlight<T>(
  jobId: string,
  work: () => Promise<T>,
): Promise<T> {
  const existing = activeRuns.get(jobId) as Promise<T> | undefined;
  if (existing) return existing;

  const run = Promise.resolve().then(work);
  activeRuns.set(jobId, run);
  try {
    return await run;
  } finally {
    if (activeRuns.get(jobId) === run) activeRuns.delete(jobId);
  }
}
