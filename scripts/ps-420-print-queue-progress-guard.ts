/**
 * PS-420 backend progress boundary guard.
 * Offline only: no DB, provider, label, queue, order, or shipment mutation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveQueueSendSnapshotStatus } from '../src/services/print-queue/queue-send-status';

const TOTAL = 12;

function terminalState(index: number) {
  if (index % 5 === 0) return 'skipped_preflight' as const;
  if (index % 4 === 0) return 'failed_terminal' as const;
  return 'queued' as const;
}

for (let completed = 1; completed <= TOTAL; completed += 1) {
  const itemStates = Array.from({ length: TOTAL }, (_, index) => ({
    orderId: index + 1,
    state: index < completed ? terminalState(index + 1) : 'ready' as const,
  }));
  const terminal = itemStates.slice(0, completed);
  const queued = terminal.filter((item) => item.state === 'queued').length;
  const skipped = terminal.filter((item) => item.state === 'skipped_preflight').length;
  const failed = terminal.filter((item) => item.state === 'failed_terminal').length;
  const status = deriveQueueSendSnapshotStatus({
    status: 'running',
    current: 0,
    total: TOTAL,
    queued: 0,
    skipped: 0,
    failed: 0,
    updatedAt: '2026-07-10T12:00:00.000Z',
    itemStates,
  }, {
    now: Date.parse('2026-07-10T12:00:01.000Z'),
    inMemoryJobPresent: false,
  });

  assert.equal(status.completedOrderAttempts, completed, `completion ${completed}/${TOTAL} must be visible`);
  assert.equal(status.current, completed, `legacy current must mirror completion ${completed}/${TOTAL}`);
  assert.equal(status.orderAttemptsTotal, TOTAL);
  assert.equal(status.totalOrders, TOTAL);
  assert.equal(status.queued, queued);
  assert.equal(status.skipped, skipped);
  assert.equal(status.failed, failed);
  if (completed < TOTAL) assert.match(status.message, new RegExp(`${completed}/${TOTAL}`));
}

{
  const status = deriveQueueSendSnapshotStatus({
    status: 'running',
    current: 0,
    total: 3,
    queued: 0,
    skipped: 0,
    failed: 0,
    updatedAt: '2026-07-10T12:00:00.000Z',
    itemStates: [
      { orderId: 1, state: 'provider_pending' },
      { orderId: 2, state: 'provider_pending_recovery' },
      { orderId: 3, state: 'ready' },
    ],
  }, {
    now: Date.parse('2026-07-10T12:00:01.000Z'),
    inMemoryJobPresent: false,
  });
  assert.equal(status.providerPending, 2);
  assert.equal(status.inProgress, 2);
  assert.equal(status.completedOrderAttempts, 0);
  assert.match(status.message, /2 provider pending/);
}

{
  const status = deriveQueueSendSnapshotStatus({
    status: 'error',
    current: 2,
    total: 3,
    queued: 1,
    skipped: 0,
    failed: 1,
    message: 'Provider connection failed',
  }, { inMemoryJobPresent: true });
  assert.equal(status.message, 'Provider connection failed');
}

const service = readFileSync('src/services/print-queue.ts', 'utf8');
const store = readFileSync('src/services/print-queue/queue-send-job-store.ts', 'utf8');
const route = readFileSync('src/routes/print-queue.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

assert.ok(service.includes('QUEUE_SEND_PROGRESS_SNAPSHOT_OPTIONS'));
assert.match(service, /persistItems:\s*false/);
assert.match(service, /persistLegacy:\s*false/);
assert.match(service, /await persistQueueSendJobSnapshot\(job, QUEUE_SEND_PROGRESS_SNAPSHOT_OPTIONS\)/);
assert.ok(!/shouldPersistProgress\(job\.current/.test(service));
assert.match(service, /shouldPersistMergeProgress\(processed, sorted\.length\)/);
assert.ok(service.includes('getQueueSendJobItemRecords'));
assert.match(
  store,
  /WHERE print_queue_send_jobs\.generation = \$\{snapshot\.generation\}[\s\S]*?snapshot_updated_at[\s\S]*?<= \$\{snapshot\.persistedAt\}/,
  'progress/full snapshots must remain monotonic inside the current durable generation',
);
assert.match(route, /completed_order_attempts:/);
assert.match(route, /order_attempts_total:/);
assert.match(route, /progress_semantics:\s*'order_attempts'/);
assert.match(route, /provider_pending:/);
assert.match(route, /in_progress:/);
assert.match(ordersView, /const current = toNumberValue\(status\.current\) \?\? 0/);
assert.match(ordersView, /BACKEND_QUEUE_SEND_POLL_MS = 750/);
assert.ok(pkg.includes('"test:ps-420-print-queue-progress"'));

console.log('PASS PS-420 per-order Print Queue progress guard');
