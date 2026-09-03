/**
 * Audit 2026-07-13 SY-4/SY-6/SY-7 sync watchdog lifecycle guard.
 *
 * Offline only: no DB connection/write, provider call, label/postage purchase,
 * marketplace notification, or production shipped/cancelled mutation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const {
  heartbeatGatedWatchdogAction,
  describeStaleOrderAccounts,
  evaluateShipmentSyncWatchdog,
} = await import('../src/services/shipment-sync-watchdog');
const { nextOrderSyncResumePage } = await import('../src/services/order-sync');

const read = (path: string): string => readFileSync(path, 'utf8');
const watchdog = read('src/services/shipment-sync-watchdog.ts');
const orderSync = read('src/services/order-sync.ts');
const storeImport = read('src/services/store-order-import.ts');
const shopify = read('src/connectors/store/shopify.ts');
const packageJson = read('package.json');
const guardPack = read('scripts/sot-guard-pack.mjs');

assert.equal(
  heartbeatGatedWatchdogAction('restart_worker', false),
  'alert_only',
  'a fresh heartbeat must turn every restart request into an alert',
);
assert.equal(
  heartbeatGatedWatchdogAction('restart_worker', true),
  'restart_worker',
  'a stale heartbeat may retain the restart recommendation',
);
assert.equal(
  heartbeatGatedWatchdogAction('enqueue_order_sync', false),
  'enqueue_order_sync',
  'the heartbeat gate must not suppress safe queue recovery',
);

const staleAccount = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-14T08:00:00Z'),
  orderLastSyncedAt: '2026-07-14T07:59:00Z',
  shipmentLastSyncedAt: '2026-07-14T07:59:00Z',
  workerHeartbeatAgeSeconds: 30,
  queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 10, missingActiveShipments: 0 },
  consecutiveBacklogChecks: 0,
  staleOrderAccountCount: 1,
});
assert.equal(staleAccount.state, 'order_account_stale');
assert.equal(staleAccount.orderFresh, false);
assert.equal(staleAccount.recommendedAction, 'enqueue_order_sync');
// PS-484: the 503 names the account and the clause — the evidence the original 503 never left.
const namedStaleAccount = evaluateShipmentSyncWatchdog({
  nowMs: Date.parse('2026-07-14T08:00:00Z'),
  orderLastSyncedAt: '2026-07-14T07:59:00Z',
  shipmentLastSyncedAt: '2026-07-14T07:59:00Z',
  workerHeartbeatAgeSeconds: 30,
  queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
  missingShipments: { recentShippedOrders: 10, missingActiveShipments: 0 },
  consecutiveBacklogChecks: 0,
  staleOrderAccountCount: 1,
  staleOrderAccounts: [
    { accountId: 'main', staleReasons: ['run_abandoned'], lastError: 'Order sync worker no longer owns this job.' },
  ],
});
assert.equal(
  namedStaleAccount.reason,
  '1 order sync account(s) are stale or failed: main=run_abandoned (Order sync worker no longer owns this job.)',
  'the verdict text carries the account and its clause',
);
assert.equal(
  evaluateShipmentSyncWatchdog({
    nowMs: Date.parse('2026-07-14T08:00:00Z'),
    orderLastSyncedAt: '2026-07-14T07:59:00Z',
    shipmentLastSyncedAt: '2026-07-14T07:59:00Z',
    workerHeartbeatAgeSeconds: 30,
    queue: { created: 0, retry: 0, active: 0, failed: 0, activeMaxAgeSeconds: null },
    missingShipments: { recentShippedOrders: 10, missingActiveShipments: 0 },
    consecutiveBacklogChecks: 0,
    staleOrderAccountCount: 2,
    staleOrderAccounts: [
      { accountId: 'main', staleReasons: ['never_synced'], lastError: null },
      { accountId: 'client:11', staleReasons: ['watermark_stale', 'status_backlog_stalled'], lastError: null },
    ],
  }).reason,
  '2 order sync account(s) are stale or failed: main=never_synced; client:11=watermark_stale+status_backlog_stalled',
  'several accounts, several clauses, one line',
);
assert.equal(describeStaleOrderAccounts([{ accountId: 'x', staleReasons: [], lastError: null }]), 'x=unknown',
  'an account flagged with no listed clause says so rather than hiding it');

assert.equal(
  nextOrderSyncResumePage({ complete: false, startPage: 1, lastPageProcessed: 1 }),
  2,
  'a partial first pass must resume at page 2',
);
assert.equal(
  nextOrderSyncResumePage({ complete: false, startPage: 8, lastPageProcessed: 1 }),
  8,
  'a resumed pass that only probes page 1 must retain its older backlog cursor',
);
assert.equal(
  nextOrderSyncResumePage({ complete: false, startPage: 8, lastPageProcessed: 9 }),
  10,
  'a resumed pass that drains backlog must advance past the last processed page',
);
assert.equal(
  nextOrderSyncResumePage({ complete: true, startPage: 8, lastPageProcessed: 9 }),
  1,
  'a complete pass must reset to newest-first page 1',
);

// PS-471 (2026-07-30): was pinned to `withAdvisoryTransactionLock(`. This
// check's own name is "must use ONE cross-process advisory lock" -- a single
// acquisition on the canonical key is the stated invariant, and naming the
// blocking variant was an over-specific way of writing it. That over-specificity
// forbade the fix for the outage blocking itself caused: ticks queued behind a
// stranded transaction, each pinning a pooler connection, until nothing could
// reach the database.
//
// Still enforced here, and it is the part that matters: exactly one lock on
// WATCHDOG_TICK_LOCK -- not zero (unserialized ticks), not two. WHICH primitive
// is correct is owned by ps-471-advisory-lock-safety-guard, which pins the tick
// to the non-blocking acquire and pins the read-modify-write callers to the
// blocking one.
//
// Third guard in this repo found pinning a tuning/implementation detail rather
// than a property; the other two were the cron cadence literals.
assert.equal(
  watchdog.match(/(?:try|with)AdvisoryTransactionLock\(WATCHDOG_TICK_LOCK/g)?.length,
  1,
  'the canonical timer/cron tick must use one cross-process advisory lock',
);
assert.match(
  watchdog,
  /watchdogTimer = setInterval\([\s\S]*?runShipmentSyncWatchdogTick\(\{ recover: true, source: 'timer' \}\)\.catch/,
  'scheduled watchdog ticks must contain rejected promises instead of crashing the API',
);
assert.doesNotMatch(read('src/routes/sync.ts'), /nudgeShipmentSyncWatchdogRecovery/,
  'the status read must remain observational and side-effect free');
assert.match(read('src/routes/cron.ts'),
  /app\.post\('\/shipment-sync-watchdog'[\s\S]*runShipmentSyncWatchdogTick[\s\S]*app\.get\('\/shipment-sync-watchdog'[\s\S]*runShipmentSyncWatchdogTick/,
  'both cron drivers must delegate to the advisory-locked canonical tick');
assert.match(
  watchdog,
  /if \(!status\.verdict\.workerStale\)[\s\S]*worker heartbeat is fresh; restart blocked/,
  'the Render boundary must defensively reject restarts with a fresh heartbeat',
);
assert.match(
  watchdog,
  /function orderAccountAlerts\([\s\S]*filter\(\(account\) => account\.stale\)/,
  'watchdog account alerts must consume canonical order-sync account diagnostics',
);
assert.match(watchdog, /accountAlerts: status\.orders\.accountAlerts/,
  'per-account alert facts must be persisted in the watchdog snapshot');
assert.match(watchdog, /for \(const account of status\.orders\.accountAlerts\)/,
  'each stale account must emit an independently attributable alert');

assert.match(
  orderSync,
  /AWAITING_RESUME_CURSOR_KEY_PREFIX = 'order_sync\.awaiting_resume_page'/,
  'awaiting imports must use a durable backend settings cursor',
);
assert.match(
  orderSync,
  /awaitingOrderResumeCursorKey[\s\S]*shipStationSyncAccountId\(account\)/,
  'awaiting cursors must be isolated by canonical account identity and store target',
);
assert.match(
  orderSync,
  /orderStatus: 'awaiting_shipment'[\s\S]*sortDir: 'DESC'[\s\S]*startPage[\s\S]*probeFirstPageOnResume: false/,
  'awaiting imports must resume the frozen window directly instead of replaying page 1',
);
assert.match(
  orderSync,
  /await setJsonSetting\(cursorKey, buildAwaitingOrderCursorState\(/,
  'awaiting cursor progress must persist only after a successful pass',
);

assert.match(
  shopify,
  /externallyShipped: normalizeShopifyStatus\(order\) === 'shipped'/,
  'Shopify adapter must remain a thin translator of provider fulfillment state',
);
assert.match(
  storeImport,
  /when excluded\.externally_shipped = true and exists \([\s\S]*from \$\{shipments\}[\s\S]*\$\{shipments\.orderId\} = \$\{orders\.id\}[\s\S]*coalesce\(\$\{shipments\.voided\}, false\) = false[\s\S]*coalesce\(\$\{shipments\.isReturn\}, false\) = false[\s\S]*\) then false/,
  'canonical import persistence must reject a provider echo when an active outbound shipment exists',
);
assert.match(
  storeImport,
  /Per user override unlock shipped data on 2026-07-14 \(Audit SY-6\)/,
  'the protected externally_shipped change must record the current user override',
);

assert.ok(packageJson.includes('"test:audit-sync-watchdog-lifecycle"'),
  'package must expose the SY-4/SY-6/SY-7 guard');
assert.ok(guardPack.includes("'test:audit-sync-watchdog-lifecycle'"),
  'the mandatory source-of-truth pack must run the lifecycle guard');

console.log('PASS Audit SY-4/SY-6/SY-7 sync watchdog lifecycle guard');
