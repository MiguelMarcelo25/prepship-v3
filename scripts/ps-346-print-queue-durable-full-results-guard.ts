import {
  PRINT_QUEUE_SEND_STATUS_KEY,
  toQueueSendSnapshot,
  type QueueSendSnapshotJob,
} from '../src/services/print-queue/queue-send-snapshot';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const results = Array.from({ length: 20 }, (_, index) => {
  const orderId = 1901 + index;
  return {
    orderId,
    success: index % 7 !== 0,
    queueEntryId: index % 7 === 0 ? undefined : `queue-${orderId}`,
    alreadyQueued: index === 9,
    trackingNumber: index % 7 === 0 ? null : `1ZTEST${orderId}`,
    error: index % 7 === 0 ? `Order ${orderId} failed` : undefined,
    retryEligible: index % 7 === 0,
    retryReason: index % 7 === 0 ? 'rate-proof-stale' : null,
  };
});

const job: QueueSendSnapshotJob = {
  jobId: 'ps-346-full-results',
  status: 'done',
  clientIds: [4],
  progress: 20,
  total: 20,
  current: 20,
  queued: 17,
  failed: 3,
  message: 'Queued 17/20, 3 failed',
  clientId: 4,
  createdAt: 1_774_838_400_000,
  updatedAt: 1_774_838_430_000,
  results,
  queuedEntryIds: results
    .filter((result) => result.queueEntryId)
    .map((result) => String(result.queueEntryId)),
  errorMessage: null,
};

const snapshot = toQueueSendSnapshot(job, { now: 1_774_838_431_000 });

assert(snapshot.durableKey === PRINT_QUEUE_SEND_STATUS_KEY, 'snapshot uses the durable batch-send key');
assert(snapshot.results.length === 20, 'durable snapshot preserves every per-order result');
assert(snapshot.resultSamples.length === 10, 'durable snapshot keeps a compact 10-result preview');
assert(snapshot.results[0]?.orderId === 1901, 'full results keep the earliest order');
assert(snapshot.results[19]?.orderId === 1920, 'full results keep the latest order');
assert(snapshot.resultSamples[0]?.orderId === 1911, 'samples remain the latest 10 orders');
assert(snapshot.results[0]?.retryEligible === true, 'full results preserve retry eligibility');
assert(snapshot.results[0]?.retryReason === 'rate-proof-stale', 'full results preserve retry reason');
assert(snapshot.results[0]?.error === 'Order 1901 failed', 'full results preserve failure detail');
assert(snapshot.persistedAt === '2026-03-30T02:40:31.000Z', 'snapshot accepts deterministic test time');

console.log('PASS PS-346 durable queue snapshots preserve full per-order results');
