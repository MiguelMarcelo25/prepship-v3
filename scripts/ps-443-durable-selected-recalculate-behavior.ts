/**
 * PS-443 boundary proof for durable Recalculate Selected batches.
 *
 * In-memory only: no DB, network, carrier, label, or marketplace side effects.
 */
import assert from 'node:assert/strict';
import {
  getRateRecalculateBatch,
  rateRecalculateBatchKeysToPrune,
  RATE_RECALCULATE_BATCH_PREFIX,
  retryRateRecalculateBatch,
  startRateRecalculateBatch,
  type RateRecalculateBatchSnapshot,
  type RateRecalculateBatchStartItem,
} from '../src/services/rate-recalculate-batch';
import type { RateBrowseWorkflowSnapshot } from '../src/services/rate-browse-workflow-types';

process.env.NODE_ENV = 'test';

const at = '2026-07-24T00:00:00.000Z';
assert.deepEqual(
  rateRecalculateBatchKeysToPrune([
    { key: `${RATE_RECALCULATE_BATCH_PREFIX}old`, value: JSON.stringify({ updatedAt: '2026-07-16T23:59:59.000Z' }) },
    { key: `${RATE_RECALCULATE_BATCH_PREFIX}fresh`, value: JSON.stringify({ updatedAt: '2026-07-23T00:00:00.000Z' }) },
    { key: `${RATE_RECALCULATE_BATCH_PREFIX}invalid`, value: '{' },
    { key: 'adjacent.setting', value: '{}' },
  ], new Date(at)),
  [`${RATE_RECALCULATE_BATCH_PREFIX}old`, `${RATE_RECALCULATE_BATCH_PREFIX}invalid`],
  'retention deletes only expired/invalid manifests in the exact batch namespace',
);
const stored = new Map<string, RateRecalculateBatchSnapshot>();
const admissionsByOrder = new Map<number, number>();
const terminalByJob = new Map<string, RateBrowseWorkflowSnapshot>();
let persistCount = 0;
let batchSequence = 0;

function workflow(
  jobId: string,
  orderId: number,
  phase: RateBrowseWorkflowSnapshot['phase'],
  options: {
    action?: 'apply' | 'clear' | 'blocked';
    message?: string;
    error?: string;
  } = {},
): RateBrowseWorkflowSnapshot {
  const terminal = phase === 'complete' || phase === 'error';
  return {
    jobId,
    generation: 1,
    phase,
    requestKey: null,
    orderId,
    clientId: 1,
    storeId: 1,
    totalCarriers: 2,
    completedCarriers: terminal ? 2 : 0,
    successfulCarriers: phase === 'complete' ? 1 : 0,
    failedCarriers: phase === 'error' ? 2 : 0,
    ratesCount: options.action === 'apply' ? 1 : 0,
    startedAt: at,
    updatedAt: at,
    finishedAt: terminal ? at : null,
    message: options.message ?? (terminal ? 'Finished' : 'Queued'),
    result: options.action
      ? { strictRecalculation: { action: options.action, message: options.message } }
      : null,
    diagnostics: {},
    error: options.error ?? null,
  };
}

function terminalFor(jobId: string, orderId: number, admission: number): RateBrowseWorkflowSnapshot {
  if (admission > 1 || orderId === 100) {
    return workflow(jobId, orderId, 'complete', { action: 'apply', message: 'Retry applied.' });
  }
  switch (orderId % 10) {
    case 1:
      return workflow(jobId, orderId, 'complete', { action: 'clear', message: 'No rates returned.' });
    case 2:
      return workflow(jobId, orderId, 'error', { error: 'Provider timed out.' });
    case 3:
      return workflow(jobId, orderId, 'complete', { action: 'blocked', message: 'Rate proof persistence rejected.' });
    case 4:
      return workflow(jobId, orderId, 'error', { error: 'Cancelled by operator.' });
    case 5:
      return workflow(jobId, orderId, 'complete', { message: 'Missing strict verdict.' });
    case 7:
      return workflow(jobId, orderId, 'error', { error: 'Network connection failed.' });
    default:
      return workflow(jobId, orderId, 'complete', { action: 'apply', message: 'Best rate applied.' });
  }
}

const deps = {
  now: () => new Date(at),
  createId: () => `batch-${++batchSequence}`,
  readBatch: async (batchId: string) => {
    const value = stored.get(batchId);
    return value ? structuredClone(value) : null;
  },
  persistBatch: async (snapshot: RateRecalculateBatchSnapshot) => {
    persistCount += 1;
    stored.set(snapshot.batchId, structuredClone(snapshot));
  },
  pruneBatches: async () => undefined,
  startWorkflow: async (input: { orderId?: number | null }) => {
    const orderId = Number(input.orderId);
    const admission = (admissionsByOrder.get(orderId) ?? 0) + 1;
    admissionsByOrder.set(orderId, admission);
    const jobId = `job-${orderId}-${admission}`;
    terminalByJob.set(jobId, terminalFor(jobId, orderId, admission));
    return workflow(jobId, orderId, 'queued');
  },
  getWorkflow: async (jobId: string) => terminalByJob.get(jobId) ?? null,
};

const items: RateRecalculateBatchStartItem[] = Array.from({ length: 100 }, (_, index) => {
  const orderId = index + 1;
  if (orderId === 98) {
    return {
      orderId,
      initialOutcome: {
        status: 'skipped',
        reasonCode: 'skipped_immutable_order',
        message: 'Immutable order.',
        retryable: false,
      },
    };
  }
  if (orderId === 99) {
    return {
      orderId,
      initialOutcome: {
        status: 'skipped',
        reasonCode: 'skipped_test_order',
        message: 'Test order.',
        retryable: false,
      },
    };
  }
  if (orderId === 100) {
    return {
      orderId,
      initialOutcome: {
        status: 'failed_retryable',
        reasonCode: 'missing_shipment_inputs',
        message: 'Missing inputs.',
        retryable: true,
      },
    };
  }
  return { orderId, body: { orderId, strictRecalculate: true } };
});

const started = await startRateRecalculateBatch(
  { items, canViewFinancials: true },
  deps,
);
assert.equal(started.items.length, 100, 'admits a full 100-order manifest');
assert.equal(started.counters.remaining, 97, 'initial terminal skips/failures are counted exactly');

const writesAfterAdmission = persistCount;
// Simulate a different server process after refresh: only the persisted batch ID
// and durable per-order workflow store are reused.
const restored = await getRateRecalculateBatch(started.batchId, { ...deps });
assert.ok(restored, 'batch reattaches after process/browser refresh');
assert.equal(restored.status, 'complete');
assert.deepEqual(restored.counters, {
  total: 100,
  completed: 100,
  remaining: 0,
  running: 0,
  updated: 37,
  cleared: 10,
  skipped: 2,
  retryableFailed: 41,
  terminalFailed: 10,
});
assert.equal(persistCount, writesAfterAdmission, 'poll projection is read-only');
assert.equal(restored.items.find((item) => item.orderId === 2)?.reasonCode, 'provider_timeout');
assert.equal(restored.items.find((item) => item.orderId === 3)?.reasonCode, 'rate_persistence_rejected');
assert.equal(restored.items.find((item) => item.orderId === 7)?.reasonCode, 'transport_failure');
assert.equal(restored.items.find((item) => item.orderId === 100)?.reasonCode, 'missing_shipment_inputs');

const retryableCount = restored.items.filter((item) => item.retryable).length;
assert.equal(retryableCount, 51, 'only exact retryable failures/no-rate outcomes are retry candidates');
const retried = await retryRateRecalculateBatch(
  started.batchId,
  {
    canViewFinancials: true,
    items: restored.items.map((item) => ({ orderId: item.orderId, body: { orderId: item.orderId } })),
  },
  deps,
);
assert.ok(retried);
assert.equal(
  [...admissionsByOrder.values()].reduce((sum, count) => sum + count, 0),
  97 + retryableCount,
  'retry does not restart updated, skipped, cancelled, or terminal rows',
);

const retryFinished = await getRateRecalculateBatch(started.batchId, deps);
assert.ok(retryFinished);
assert.deepEqual(retryFinished.counters, {
  total: 100,
  completed: 100,
  remaining: 0,
  running: 0,
  updated: 88,
  cleared: 0,
  skipped: 2,
  retryableFailed: 0,
  terminalFailed: 10,
});

console.log('PASS PS-443 durable selected recalculation behavior (100 mixed orders, refresh, exact retry)');
