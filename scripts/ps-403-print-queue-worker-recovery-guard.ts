import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRINT_QUEUE_SEND_STATUS_KEY,
  toQueueSendSnapshot,
  type QueueSendSnapshotJob,
} from '../src/services/print-queue/queue-send-snapshot';
import type { QueueSendOrderInput } from '../src/services/print-queue';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function syntheticOrders(count: number): QueueSendOrderInput[] {
  return Array.from({ length: count }, (_, index) => ({
    orderId: 50_000 + index,
    clientId: 99,
    orderNumber: `PS403-${index + 1}`,
    labelUrl: null,
    label: {
      carrierCode: 'stamps_com',
      serviceCode: 'usps_ground_advantage',
      shippingProviderId: 123,
      weightOz: 16,
      length: 12,
      width: 10,
      height: 3,
      selectedRateProof: {
        source: 'synthetic',
        currentRequestFingerprint: `fp-${index}`,
        savedRequestFingerprint: `fp-${index}`,
      },
    },
    skuGroupId: 'ps403',
    primarySku: 'SKU-PS403',
    itemDescription: 'Synthetic PS-403 order',
    orderQty: 1,
    multiSkuData: null,
  }));
}

function snapshotFor(count: number) {
  const orders = syntheticOrders(count);
  const job: QueueSendSnapshotJob = {
    jobId: `ps-403-${count}`,
    status: 'running',
    clientIds: [99],
    progress: 0,
    total: count,
    current: 0,
    queued: 0,
    skipped: 0,
    failed: 0,
    message: `Sending to queue 0/${count}`,
    clientId: 99,
    createdAt: 1_783_392_000_000,
    updatedAt: 1_783_392_010_000,
    results: [],
    queuedEntryIds: [],
    errorMessage: null,
    itemStates: orders.map((order) => ({
      orderId: order.orderId,
      clientId: order.clientId,
      state: 'ready',
    })),
    workerOrders: orders,
    workerConcurrency: 4,
    workerScope: { scopeRestricted: false },
  };
  return toQueueSendSnapshot(job, { now: 1_783_392_020_000 });
}

check('durable snapshot stores worker payload needed to resume the 30-label incident shape', () => {
  const snapshot = snapshotFor(30);
  assert.equal(snapshot.durableKey, PRINT_QUEUE_SEND_STATUS_KEY);
  assert.equal(snapshot.workerOrders.length, 30);
  assert.equal(snapshot.itemStates.length, 30);
  assert.equal(snapshot.workerConcurrency, 4);
  assert.equal(snapshot.workerScope?.scopeRestricted, false);
});

check('durable snapshot can carry 100-label workflow payload without losing item state', () => {
  const snapshot = snapshotFor(100);
  assert.equal(snapshot.workerOrders.length, 100);
  assert.equal(snapshot.itemStates.length, 100);
  assert.equal(snapshot.resultSamples.length, 0);
});

check('durable snapshot can carry 1000-label synthetic payload for worker recovery planning', () => {
  const snapshot = snapshotFor(1000);
  assert.equal(snapshot.workerOrders.length, 1000);
  assert.equal(snapshot.itemStates.length, 1000);
  assert.equal(snapshot.workerOrders.at(-1)?.orderNumber, 'PS403-1000');
});

check('batch-send route accepts 1000 order intents but still delegates to backend job owner', () => {
  const route = read('src/routes/print-queue.ts');
  assert.match(route, /orders\.length \+ body\.preflight_skips\.length <= 1000/);
  assert.match(route, /const result = await startQueueSendJob/);
});

check('API service no longer falls back to long-running in-process queue-send execution', () => {
  const service = read('src/services/print-queue.ts');
  assert.doesNotMatch(service, /void runQueueSendJob/);
  assert.match(service, /job will not run in the API process/);
  assert.match(service, /queueSendJobs\.delete\(jobId\)/);
});

check('worker-owned jobs preserve payload and use bounded provider concurrency', () => {
  const service = read('src/services/print-queue.ts');
  assert.match(service, /QUEUE_SEND_WORKER_MAX_CONCURRENCY = 4/);
  assert.match(service, /workerOrders: preflight\.readyOrders/);
  assert.match(service, /scope: input\.scope \?\? \{\}/);
  assert.match(service, /normalizeQueueSendWorkerConcurrency/);
});

check('worker startup recovery re-enqueues stale active durable jobs', () => {
  const worker = read('src/services/print-queue-worker.ts');
  const store = read('src/services/print-queue/queue-send-job-store.ts');
  assert.match(store, /getRecoverableQueueSendJobRecords/);
  assert.match(store, /status IN \('pending', 'running'\)/);
  assert.match(worker, /recoverStaleQueueSendJobs/);
  assert.match(worker, /snapshot\.workerOrders/);
  assert.match(worker, /scope: snapshot\.workerScope \?\? \{\}/);
  assert.match(worker, /singletonKey: snapshot\.jobId/);
});

check('missing legacy worker payload becomes interrupted instead of stranded running forever', () => {
  const worker = read('src/services/print-queue-worker.ts');
  assert.match(worker, /status: 'interrupted'/);
  assert.match(worker, /durable worker payload is missing/);
});

check('duplicate-postage safety remains before purchase', () => {
  const service = read('src/services/print-queue.ts');
  const processBlock = service.slice(
    service.indexOf('async function processQueueSendOrder'),
    service.indexOf('export async function startQueueSendJob'),
  );
  assert.ok(processBlock.includes('findExistingQueueSendLabel(order)'));
  assert.ok(processBlock.indexOf('findExistingQueueSendLabel(order)') < processBlock.indexOf('createLabelV2({'));
  assert.ok(processBlock.includes('waitForExistingQueueableLabel(order)'));
});
