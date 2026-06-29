import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  QUEUE_SEND_DURABLE_STALE_AFTER_MS,
  deriveQueueSendSnapshotStatus,
} from '../src/services/print-queue/queue-send-status';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const now = Date.parse('2026-06-30T00:00:00.000Z');

const staleRunning = deriveQueueSendSnapshotStatus(
  {
    status: 'running',
    current: 0,
    total: 29,
    queued: 0,
    failed: 0,
    message: 'Sending to queue 0/29',
    updatedAt: new Date(now - QUEUE_SEND_DURABLE_STALE_AFTER_MS - 1_000).toISOString(),
  },
  { now, inMemoryJobPresent: false },
);
assert.equal(staleRunning.status, 'interrupted');
assert.equal(staleRunning.active, false);
assert.equal(staleRunning.current, 0);
assert.equal(staleRunning.failed, 0);
assert.equal(staleRunning.staleReason, 'worker_missing_stale_snapshot');
assert.match(staleRunning.message, /interrupted|stale/i);

const terminalRunning = deriveQueueSendSnapshotStatus(
  {
    status: 'running',
    current: 10,
    total: 10,
    queued: 8,
    failed: 2,
    message: 'Sending to queue 10/10',
    updatedAt: new Date(now - 5_000).toISOString(),
  },
  { now, inMemoryJobPresent: false },
);
assert.equal(terminalRunning.status, 'done');
assert.equal(terminalRunning.active, false);
assert.equal(terminalRunning.current, 10);
assert.equal(terminalRunning.failed, 2);
assert.match(terminalRunning.message, /Queued 8\/10/);

const recentRunning = deriveQueueSendSnapshotStatus(
  {
    status: 'running',
    current: 0,
    total: 29,
    queued: 0,
    failed: 0,
    message: 'Sending to queue 0/29',
    updatedAt: new Date(now - 5_000).toISOString(),
  },
  { now, inMemoryJobPresent: false },
);
assert.equal(recentRunning.status, 'running');
assert.equal(recentRunning.active, true);
assert.equal(recentRunning.staleReason, null);

const printQueueRoute = read('src/routes/print-queue.ts');
assert.match(printQueueRoute, /deriveQueueSendSnapshotStatus/);
assert.match(printQueueRoute, /stale_reason:/);
assert.match(printQueueRoute, /status:\s*durableStatus\.status/);

const ordersView = read('web/src/components/Views/OrdersView.tsx');
assert.match(ordersView, /status\.status === 'interrupted'/);
assert.match(ordersView, /finishQueueActionProgress\([\s\S]{0,240}Queue interrupted[\s\S]{0,240}complete:\s*false/);

const printQueueService = read('src/services/print-queue.ts');
const labelLock = read('src/lib/label-purchase-lock.ts');
assert.match(labelLock, /export async function isLabelPurchaseLockActive/);
assert.match(printQueueService, /QueueSendStaleLabelAttemptError/);
assert.match(printQueueService, /stale_label_purchase_attempt/);
assert.match(printQueueService, /import \{ setJsonSettings \} from '\.\/settings-json'/);
assert.match(
  printQueueService,
  /await setJsonSettings\(\[\s*\{\s*key: PRINT_QUEUE_SEND_STATUS_KEY,\s*value: snapshot\s*\},\s*\{\s*key: jobKey,\s*value: snapshot\s*\},\s*\]\)/s,
);
const persistStart = printQueueService.indexOf('export async function persistQueueSendJobSnapshot');
const persistEnd = printQueueService.indexOf('export async function getQueueSendJobSnapshot', persistStart);
const persistBlock = persistStart >= 0 ? printQueueService.slice(persistStart, persistEnd) : '';
assert.doesNotMatch(persistBlock, /\.values\(\[\s*\{\s*key: PRINT_QUEUE_SEND_STATUS_KEY/);

const pkg = read('package.json');
assert.match(pkg, /"test:ps-354-print-queue-stale-job"/);

console.log('PASS PS-354 print queue stale job guard');
