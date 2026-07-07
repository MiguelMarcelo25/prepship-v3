/**
 * PS-401 guard - mixed Print Queue send must persist and display per-order
 * preflight skips separately from carrier/backend failures.
 *
 * Offline/static only: no DB, no provider calls, no labels, no queue mutation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatQueuedOrdersToast } from '../web/src/components/Views/orders-queue';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function blockBetween(text: string, startNeedle: string, endNeedle: string): string {
  const start = text.indexOf(startNeedle);
  if (start < 0) return '';
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  return text.slice(start, end > start ? end : start + 5000);
}

const mixedToast = formatQueuedOrdersToast(21, [], {
  skippedCount: 18,
  failedCount: 0,
  skippedReasons: [
    'Order HUGRAB-1001: Saved rate not current (rate changed) - recalculate before queueing; no postage was purchased',
    'Order HUGRAB-1002: Missing package dimensions',
  ],
});

assert.match(mixedToast, /21 queued, 18 skipped/i, 'mixed toast must lead with queued/skipped counts');
assert.match(mixedToast, /Order HUGRAB-1001/i, 'mixed toast must include skipped order numbers');
assert.match(mixedToast, /Saved rate not current/i, 'mixed toast must include per-order skip reasons');
assert.doesNotMatch(mixedToast, /^✅/u, 'mixed toast must not be green-only success');
assert.doesNotMatch(mixedToast, /18 failed/i, 'mixed toast must not label preflight skips as failed');
assert.doesNotMatch(mixedToast, /\(18 skipped\)/i, 'mixed toast must not hide skips as a parenthetical after success');

const printQueue = read('src/services/print-queue.ts');
const preflight = read('src/services/print-queue/queue-send-preflight.ts');
const snapshot = read('src/services/print-queue/queue-send-snapshot.ts');
const status = read('src/services/print-queue/queue-send-status.ts');
const itemState = read('src/services/print-queue/queue-send-item-state.ts');
const route = read('src/routes/print-queue.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const apiClient = read('web/src/lib/v2-apiClient.ts');
const pkg = read('package.json');

const startBlock = blockBetween(
  printQueue,
  'export async function startQueueSendJob',
  'export function getQueueSendJobStatus',
);
const pollBlock = blockBetween(
  ordersView,
  'async function pollBackendQueueSendJob',
  'async function refreshQueueAfterBackendStatus',
);
const sendBlock = blockBetween(
  ordersView,
  'async function sendOrdersToQueueBackend',
  'async function queueExistingLabels',
);

assert.ok(printQueue.includes('export type QueueSendPreflightSkipInput'), 'service must define frontend preflight skip input');
assert.ok(startBlock.includes('preflightSkips?: QueueSendPreflightSkipInput[]'), 'startQueueSendJob must accept preflight skips');
assert.ok(startBlock.includes('skipped: skippedResults.length'), 'job must persist skipped count from preflight skips');
assert.ok(startBlock.includes('failed: 0'), 'preflight skips must not initialize failed count');
assert.ok(!startBlock.includes("if (!input.orders.length) throw new Error('orders must be non-empty')"), 'skip-only jobs must be allowed');

assert.ok(preflight.includes('skipped: true'), 'backend preflight blocks must mark results skipped');
assert.ok(preflight.includes('skipReason: blockMessage(reason, order)'), 'backend preflight skips must persist reason');
assert.ok(preflight.includes("state: 'skipped_preflight'"), 'backend preflight items must use skipped_preflight state');
assert.ok(itemState.includes("| 'skipped_preflight'"), 'item state union must include skipped_preflight');

assert.ok(snapshot.includes('skipped?: boolean'), 'snapshot results must persist skipped flag');
assert.ok(snapshot.includes('skipReason?: string | null'), 'snapshot results must persist skip reason');
assert.ok(snapshot.includes('skipped: number'), 'snapshot job must persist skipped count');
assert.ok(status.includes('skipped: number'), 'derived durable status must expose skipped count');
assert.ok(status.includes('doneMessage(queued, total, skipped, failed)'), 'done message must format skipped separately');

assert.ok(route.includes('preflight_skips'), 'batch-send route must accept preflight_skips');
assert.ok(route.includes('preflightSkips:'), 'batch-send route must delegate preflight skips to service');
assert.ok(route.includes('skipped: durableStatus.skipped'), 'durable status response must return skipped count');
assert.ok(route.includes('skipped: job.skipped'), 'in-memory status response must return skipped count');

assert.ok(apiClient.includes('preflight_skips?: Array<Record<string, unknown>>'), 'API client must type preflight_skips');
assert.ok(sendBlock.includes('preflight_skips: preflightSkips'), 'OrdersView must send skipped orders into durable job');
assert.ok(sendBlock.includes('result.skipped === true'), 'OrdersView must split skipped results from failures');
assert.ok(!sendBlock.includes('failed: skippedFailed +'), 'OrdersView must not add frontend skips to failed count');
assert.ok(!pollBlock.includes('failedOffset'), 'polling must not offset skipped orders into failed count');
assert.ok(ordersView.includes('skipped: number'), 'queue progress must track skipped separately');
assert.ok(ordersView.includes("`${progress.skipped} skipped`"), 'progress detail must show skipped separately');

assert.ok(
  pkg.includes('"test:ps-401-print-queue-mixed-success": "tsx scripts/ps-401-print-queue-mixed-success-guard.ts"'),
  'package.json must wire the PS-401 guard',
);

console.log('PASS ps-401 print queue mixed-success guard');
