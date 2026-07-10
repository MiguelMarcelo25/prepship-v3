import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const { mergeOrderStatusCatchupEntries } = await import('../src/services/order-sync');
const {
  sanitizeShipStationSyncError,
  shipStationSyncAccountId,
  summarizeShipStationAccountWatermarks,
} = await import('../src/services/shipstation-sync-account-state');

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
assert.match(accountState, /lastSuccessAt/);
assert.match(accountState, /lastFailureAt/);
assert.match(orderSync, /summarizeShipStationAccountWatermarks/);
assert.match(orderSync, /staleAccountCount/);
assert.match(orderSync, /\.sort\(\(left, right\) => \(left\.watermarkMs \?\? 0\) - \(right\.watermarkMs \?\? 0\)\)/);
assert.match(orderSync, /mergeOrderStatusCatchupEntries/);

assert.doesNotMatch(scheduler, /from ['"]\.\/order-sync['"]/);
assert.doesNotMatch(scheduler, /from ['"]\.\/shipment-sync['"]/);
assert.match(queue, /registerWorker\(JOBS\.orders/);
assert.match(queue, /registerWorker\(JOBS\.shipments/);
for (const route of [cronRoute, ordersRoute, shipmentsRoute, adminRoute]) {
  assert.doesNotMatch(route, /await syncOrders\(/);
  assert.doesNotMatch(route, /await syncShipments\(/);
}

assert.match(syncRoute, /readShipmentSyncWatchdogStatus/);
assert.doesNotMatch(syncRoute, /nudgeShipmentSyncWatchdogRecovery/);
assert.match(syncRoute, /latestSync:/);
assert.match(ui, /accountDiagnostics/);
assert.match(ui, /staleAccountCount/);
assert.match(home, /next\.latestSync \?\? next\.lastSync/);
assert.match(
  pkg,
  /"test:ps-417-shipstation-sync-account-state"\s*:\s*"tsx scripts\/ps-417-shipstation-sync-account-state-guard\.ts"/,
);

console.log('PASS PS-417 ShipStation per-account sync state and lane guard');
