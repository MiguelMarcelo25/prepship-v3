// Per user override unlock shipped data on 2026-07-14: execution controls only.
// This module never buys postage or mutates orders/shipments; it prevents a
// timed-out parent job from admitting more work or re-entering concurrently.
export class QueueSendJobInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueSendJobInterruptedError';
  }
}

export const QUEUE_SEND_EXECUTION_CHUNK_SIZE = 100;

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
  while (queue.length > 0 || running.size > 0) {
    while (!signal?.aborted && running.size < maxConcurrent && queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        const task = fn(item).finally(() => running.delete(task));
        running.add(task);
      }
    }
    if (running.size > 0) await Promise.race(running);
    if (signal?.aborted && running.size === 0) break;
  }
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
