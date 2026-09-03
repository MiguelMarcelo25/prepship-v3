import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const { mergeOrderStatusCatchupEntries, orderSyncRunQueueVerdict } = await import('../src/services/order-sync');
const {
  finishShipStationSyncAccountRun,
  sanitizeShipStationSyncError,
  shipStationSyncAccountId,
  summarizeShipStationAccountWatermarks,
} = await import('../src/services/shipstation-sync-account-state');
const {
  OrderSyncCooperativeYieldError,
  isOrderSyncCooperativeYieldError,
} = await import('../src/lib/order-sync-cooperative-yield');
const { classifyOrderSyncQueueRows } = await import('../src/services/order-sync-queue-state');
const { formatSyncPill } = await import('../web/src/components/Views/orders-parity');

const previous = {
  accountLabel: 'main',
  storeId: null,
  orderStatus: 'shipped',
  sinceIso: '2026-07-01T00:00:00.000Z',
  sortDir: 'DESC',
  pageSize: 100,
  startPage: 4,
  totalPages: 10,
  pagesProcessed: 2,
  lastPageProcessed: 4,
  nextPage: 5,
  updatedRows: 2,
  hasBacklog: true,
  backlogPages: 6,
  stoppedBy: 'page_budget',
  checkedAt: '2026-07-09T00:00:00.000Z',
} as const;
const skipped = {
  ...previous,
  startPage: 1,
  totalPages: null,
  pagesProcessed: 0,
  lastPageProcessed: 0,
  nextPage: 1,
  updatedRows: 0,
  backlogPages: null,
  stoppedBy: 'not_started_budget_exhausted',
  checkedAt: '2026-07-10T00:00:00.000Z',
} as const;
const activeKey = new Set(['main:all:shipped']);

const preserved = mergeOrderStatusCatchupEntries(
  [previous] as never[],
  [skipped] as never[],
  activeKey,
);
assert.equal(preserved.length, 1);
assert.equal(preserved[0]?.nextPage, 5, 'a skipped pass must retain its durable cursor');
assert.equal(preserved[0]?.totalPages, 10);
assert.equal(preserved[0]?.stoppedBy, 'not_started_budget_exhausted');

const accountNotReached = mergeOrderStatusCatchupEntries(
  [previous] as never[],
  [],
  activeKey,
);
assert.equal(accountNotReached[0]?.nextPage, 5, 'an account not reached this run must keep its backlog');

const inactiveAccount = mergeOrderStatusCatchupEntries(
  [previous] as never[],
  [],
  new Set(),
);
assert.deepEqual(inactiveAccount, [], 'inactive accounts must not leave permanent backlog diagnostics');

assert.equal(shipStationSyncAccountId({ label: 'main', ownerClientId: null }), 'main');
assert.equal(shipStationSyncAccountId({ label: 'client:Renamed', ownerClientId: 42 }), 'client:42');
assert.deepEqual(summarizeShipStationAccountWatermarks([100, 500]), {
  completeThroughMs: 100,
  latestMs: 500,
});
assert.deepEqual(summarizeShipStationAccountWatermarks([null, 500]), {
  completeThroughMs: null,
  latestMs: 500,
});
const sanitized = sanitizeShipStationSyncError(
  'token=secret-value API_KEY:another-secret https://provider.example/orders',
);
assert.doesNotMatch(sanitized, /secret-value|another-secret|provider\.example/);
assert.match(sanitized, /\[redacted\]/);

const attemptOne = { queueJobId: 'queue-1', attemptId: 'attempt-1' };
const runningState = {
  accountId: 'main',
  storeIds: [],
  status: 'running',
  activeJobId: attemptOne.queueJobId,
  activeAttemptId: attemptOne.attemptId,
  lastStartedAt: '2026-07-10T00:00:00.000Z',
  lastCompletedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
} as const;
const finished = finishShipStationSyncAccountRun(runningState, attemptOne, {
  status: 'succeeded',
  completedAt: '2026-07-10T00:01:00.000Z',
});
assert.equal(finished?.status, 'succeeded');
assert.equal(finished?.activeJobId, null);
const deferred = finishShipStationSyncAccountRun(
  {
    ...runningState,
    lastSuccessAt: '2026-07-09T23:59:00.000Z',
    lastFailureAt: '2026-07-09T23:58:00.000Z',
    lastError: 'prior real failure',
  },
  attemptOne,
  {
    status: 'deferred',
    completedAt: '2026-07-10T00:01:30.000Z',
  },
);
assert.equal(deferred?.status, 'deferred');
assert.equal(deferred?.activeJobId, null);
assert.equal(deferred?.lastSuccessAt, '2026-07-09T23:59:00.000Z');
assert.equal(deferred?.lastFailureAt, '2026-07-09T23:58:00.000Z');
assert.equal(deferred?.lastError, null);
assert.equal(
  isOrderSyncCooperativeYieldError(new OrderSyncCooperativeYieldError()),
  true,
  'durable queue-control yields must have an explicit non-failure identity',
);
assert.equal(
  finishShipStationSyncAccountRun(
    { ...runningState, activeAttemptId: 'attempt-2' },
    attemptOne,
    { status: 'failed', completedAt: '2026-07-10T00:02:00.000Z' },
  ),
  undefined,
  'an old timed-out attempt must not close a newer retry',
);

const queueTruth = classifyOrderSyncQueueRows([
  { id: 'active-1', state: 'active' },
  { id: 'retry-1', state: 'retry' },
  { id: 'queued-1', state: 'created' },
]);
const activeVerdict = orderSyncRunQueueVerdict(
  { status: 'running', activeJobId: 'active-1', lastStartedAt: '2026-07-10T00:00:00.000Z' },
  queueTruth,
  Date.parse('2026-07-10T00:01:00.000Z'),
);
assert.equal(activeVerdict.running, true);
assert.equal(activeVerdict.recovering, false);
// PS-484: an attempt pg-boss holds for a retry is recovery in progress, not an abandoned run —
// calling it abandoned made the account "failed" and /health/deep 503 for the retry delay.
const retryVerdict = orderSyncRunQueueVerdict(
  { status: 'running', activeJobId: 'retry-1', lastStartedAt: '2026-07-10T00:00:00.000Z' },
  queueTruth,
  Date.parse('2026-07-10T00:01:00.000Z'),
);
assert.equal(retryVerdict.running, false);
assert.equal(retryVerdict.abandoned, false, 'a queued retry is not abandoned');
assert.equal(retryVerdict.recovering, true);
assert.match(retryVerdict.error ?? '', /queued to retry/);
// ...and a run the queue no longer lists at all IS abandoned, within the lease or past it.
const orphanVerdict = orderSyncRunQueueVerdict(
  { status: 'running', activeJobId: 'gone-1', lastStartedAt: '2026-07-10T00:00:00.000Z' },
  queueTruth,
  Date.parse('2026-07-10T00:01:00.000Z'),
);
assert.equal(orphanVerdict.abandoned, true, 'a run no live queue row owns is abandoned');
assert.equal(orphanVerdict.recovering, false);
assert.match(orphanVerdict.error ?? '', /no longer owns/);
const deadlineVerdict = orderSyncRunQueueVerdict(
  { status: 'running', activeJobId: 'active-1', lastStartedAt: '2026-07-10T00:00:00.000Z' },
  queueTruth,
  Date.parse('2026-07-10T01:00:00.000Z'),
);
assert.equal(deadlineVerdict.abandoned, true, 'past the lease the run is abandoned even if the row is active');
assert.match(deadlineVerdict.error ?? '', /worker deadline/);
// The narrowing's backstop: an orphaned pass turns 'retry' only at pg-boss expiry, and by then
// the account must already be watermark_stale — so the freshness window must sit BELOW the
// orders job's expiry. Pinned on the two defaults; raising the window past 1800s would open a
// silent gap between expiry and the retry's pickup.
{
  const envSource = readFileSync('src/lib/env.ts', 'utf8');
  const queueSource = readFileSync('src/services/sync-job-queue.ts', 'utf8');
  const product = (m: RegExpExecArray | null): number | null =>
    m ? Number(m[1]) * Number(m[2]) : null;
  const freshSeconds = product(
    /SHIPMENT_SYNC_WATCHDOG_ORDER_FRESH_SECONDS:[^\n]*?default\((\d+)\s*\*\s*(\d+)\)/.exec(envSource),
  );
  const expirySeconds = product(/expireInSeconds:\s*(\d+)\s*\*\s*(\d+)/.exec(queueSource));
  assert.ok(freshSeconds !== null && expirySeconds !== null,
    'the freshness default and the job expiry are both declared in source as <n> * <m> seconds');
  assert.ok(
    freshSeconds! < expirySeconds!,
    `PS-484 precondition: order freshness default (${freshSeconds}s) must be below job expiry (${expirySeconds}s)`,
  );
}
assert.equal(
  formatSyncPill({
    status: 'syncing',
    mode: 'incremental',
    page: 0,
    lastSync: null,
    orders: {
      health: 'running',
      accounts: [{ state: 'running', runAgeSeconds: 125 }],
    },
  }).text,
  'Syncing 2m…',
);

const read = (path: string) => readFileSync(path, 'utf8');
const orderSync = read('src/services/order-sync.ts');
const accountState = read('src/services/shipstation-sync-account-state.ts');
const queue = read('src/services/sync-job-queue.ts');
const scheduler = read('src/services/sync-scheduler.ts');
const syncRoute = read('src/routes/sync.ts');
const cronRoute = read('src/routes/cron.ts');
const ordersRoute = read('src/routes/orders.ts');
const shipmentsRoute = read('src/routes/shipments.ts');
const adminRoute = read('src/routes/admin.ts');
const ui = read('web/src/components/Views/orders-parity.ts');
const home = read('web/src/Home.tsx');
const pkg = read('package.json');

assert.match(accountState, /order_sync\.shipstation_accounts\.snapshot/);
assert.match(accountState, /activeJobId/);
assert.match(accountState, /activeAttemptId/);
assert.match(accountState, /withAdvisoryTransactionLock\(ACCOUNT_STATE_KEY/);
assert.match(accountState, /readAccountStatesInTransaction\(transaction\)/);
assert.match(accountState, /writeAccountStatesInTransaction\(transaction/);
assert.doesNotMatch(accountState, /withAdvisorySessionLock/);
assert.match(accountState, /lastSuccessAt/);
assert.match(accountState, /lastFailureAt/);
assert.match(accountState, /markShipStationSyncAccountDeferred/);
assert.match(orderSync, /isOrderSyncCooperativeYieldError/);
assert.match(orderSync, /markShipStationSyncAccountDeferred/);
assert.match(queue, /new OrderSyncCooperativeYieldError\(\)/);
assert.match(orderSync, /summarizeShipStationAccountWatermarks/);
assert.match(orderSync, /staleAccountCount/);
assert.match(orderSync, /\.sort\(\(left, right\) => \(left\.watermarkMs \?\? 0\) - \(right\.watermarkMs \?\? 0\)\)/);
assert.match(orderSync, /mergeOrderStatusCatchupEntries/);
assert.match(orderSync, /readOrderSyncQueueTruth/);
assert.match(orderSync, /runAgeSeconds/);

assert.doesNotMatch(scheduler, /from ['"]\.\/order-sync['"]/);
assert.doesNotMatch(scheduler, /from ['"]\.\/shipment-sync['"]/);
assert.match(queue, /registerWorker\(JOBS\.orders/);
assert.match(queue, /registerWorker\(JOBS\.shipments/);
assert.match(queue, /await boss\.schedule\(/);
assert.match(queue, /resolveSyncJobAdmission\(name, \{ kind: 'cadence' \}\)/);
assert.match(queue, /singletonKey: admission\.singletonKey/);
for (const route of [cronRoute, ordersRoute, shipmentsRoute, adminRoute]) {
  assert.doesNotMatch(route, /await syncOrders\(/);
  assert.doesNotMatch(route, /await syncShipments\(/);
}

assert.match(syncRoute, /readShipmentSyncWatchdogStatus/);
assert.doesNotMatch(syncRoute, /nudgeShipmentSyncWatchdogRecovery/);
assert.match(syncRoute, /latestSync:/);
assert.match(ui, /accountDiagnostics/);
assert.match(ui, /staleAccountCount/);
assert.match(ui, /runningAgeSeconds/);
assert.match(home, /next\.latestSync \?\? next\.lastSync/);
assert.match(
  pkg,
  /"test:ps-417-shipstation-sync-account-state"\s*:\s*"tsx scripts\/ps-417-shipstation-sync-account-state-guard\.ts"/,
);

console.log('PASS PS-417 ShipStation per-account sync state and lane guard');
