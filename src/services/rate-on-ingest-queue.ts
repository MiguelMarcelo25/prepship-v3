export const RATE_ON_INGEST_BATCH_SIZE = 100;

export function addRateOnIngestOrderIds(
  queue: Set<number>,
  orderIds: readonly number[],
): number {
  let added = 0;
  for (const value of orderIds) {
    if (!Number.isInteger(value) || value <= 0 || queue.has(value)) continue;
    queue.add(value);
    added += 1;
  }
  return added;
}

export function takeRateOnIngestBatch(
  queue: Set<number>,
  limit = RATE_ON_INGEST_BATCH_SIZE,
): number[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];

  const batch: number[] = [];
  for (const orderId of queue) {
    queue.delete(orderId);
    batch.push(orderId);
    if (batch.length >= boundedLimit) break;
  }
  return batch;
}
