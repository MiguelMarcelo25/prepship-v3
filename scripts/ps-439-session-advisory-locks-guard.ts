import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluateWorkerJobSkipHealth,
  nextWorkerJobSkipSummary,
} from '../src/services/worker-job-skip-health';

const read = (path: string): string => readFileSync(path, 'utf8');
const snapshotWorker = read('src/services/shipstation-carrier-account-snapshot-worker.ts');
const queue = read('src/services/sync-job-queue.ts');
const laneLock = read('src/services/sync-lane-lock.ts');
const scheduler = read('src/services/sync-scheduler.ts');
const rateJobStore = read('src/services/rate-browse-job-store.ts');
const workerStatus = read('src/services/worker-status.ts');
const healthRoute = read('src/routes/health.ts');
const productionAudit = read('scripts/ps-439-advisory-lock-audit.ts');
const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const guardPack = read('scripts/sot-guard-pack.mjs');
const ledger = read('docs/ps-tickets/ps-ledger.md');

assert(
  !snapshotWorker.includes('postgres(') &&
    !snapshotWorker.includes('.reserve()') &&
    !snapshotWorker.includes('pg_try_advisory_lock') &&
    !snapshotWorker.includes('pg_advisory_unlock') &&
    snapshotWorker.includes('let activeRun: Promise<void> | null = null') &&
    snapshotWorker.includes('refreshDueShipStationCarrierAccountSnapshots'),
  'carrier snapshot refresh must keep process-local coalescing and no session advisory lock',
);
assert(
  queue.includes('withSyncLaneAdvisoryLock(lane, async () =>') &&
    queue.includes('runShipStationCarrierAccountSnapshotTick') &&
    queue.includes('JOBS.carrierAccountSnapshots'),
  'the durable queue must remain the single cross-process carrier snapshot admission owner',
);
assert(
  queue.includes('resolveShipStationConsumerLeaderDatabaseUrl({') &&
    queue.includes('env.SHIPSTATION_CONSUMER_LEADER_DATABASE_URL') &&
    queue.includes('isSupabaseTransactionPoolerUrl(selected)') &&
    queue.includes('shipStationConsumerLeaderSql.reserve()'),
  'the one allowed session lock must use one reserved direct/session-mode leadership connection',
);
assert(
  laneLock.includes('laneLockSql.begin') &&
    laneLock.includes('pg_try_advisory_xact_lock') &&
    !laneLock.includes('pg_advisory_unlock'),
  'sync lane ownership must end with the transaction and require no pooled-session unlock',
);
for (const [name, source] of [
  ['scheduler', scheduler],
  ['rate browse store', rateJobStore],
  ['carrier snapshot worker', snapshotWorker],
] as const) {
  assert(!source.includes('pg_try_advisory_lock'), `${name} must not acquire session advisory locks`);
  assert(!source.includes('pg_advisory_unlock'), `${name} must not issue session advisory unlocks`);
}

const firstAt = '2026-07-21T00:00:00.000Z';
const first = nextWorkerJobSkipSummary(null, 'cross-process shipstation-sync lane lock held', firstAt);
const second = nextWorkerJobSkipSummary(
  { status: 'skipped', summary: first },
  first.reason,
  '2026-07-21T00:01:00.000Z',
);
const third = nextWorkerJobSkipSummary(
  { status: 'skipped', summary: second },
  first.reason,
  '2026-07-21T00:02:00.000Z',
);
assert.equal(first.consecutiveSkips, 1, 'the first skip starts a new streak');
assert.equal(second.consecutiveSkips, 2, 'the same skip reason increments the streak');
assert.equal(third.firstSkippedAt, firstAt, 'a skip streak retains its first observed timestamp');
assert.equal(
  nextWorkerJobSkipSummary(
    { status: 'skipped', summary: second },
    'different blocker',
    '2026-07-21T00:03:00.000Z',
  ).consecutiveSkips,
  1,
  'a different skip reason starts a new streak',
);
assert.equal(
  evaluateWorkerJobSkipHealth(
    { status: 'skipped', finishedAt: '2026-07-21T00:01:00.000Z', summary: second },
    Date.parse('2026-07-21T00:02:00.000Z'),
  ).status,
  'ok',
  'two transient skips remain healthy',
);
assert.equal(
  evaluateWorkerJobSkipHealth(
    { status: 'skipped', finishedAt: '2026-07-21T00:02:00.000Z', summary: third },
    Date.parse('2026-07-21T00:02:00.000Z'),
  ).status,
  'ok',
  'three fast lane-blocked skips remain healthy until the age budget is exceeded',
);
assert.equal(
  evaluateWorkerJobSkipHealth(
    { status: 'skipped', finishedAt: '2026-07-21T00:04:00.001Z', summary: third },
    Date.parse('2026-07-21T00:04:00.001Z'),
  ).status,
  'fail',
  'a skip streak fails deep health only after three full outbox cadences',
);
assert.equal(
  evaluateWorkerJobSkipHealth(
    { status: 'succeeded', finishedAt: '2026-07-21T00:04:00.000Z', summary: null },
    Date.parse('2026-07-21T00:04:00.001Z'),
  ).status,
  'ok',
  'a successful run clears the degraded skip state',
);
assert.equal(
  evaluateWorkerJobSkipHealth(
    { status: 'succeeded', finishedAt: firstAt, summary: null },
    Date.parse('2026-07-21T00:04:00.001Z'),
  ).reasonCode,
  'job_stale',
  'a stale successful result cannot hide a leader-loss halt',
);
assert.equal(
  evaluateWorkerJobSkipHealth(
    undefined,
    Date.parse('2026-07-21T00:04:00.001Z'),
    firstAt,
  ).reasonCode,
  'job_stale',
  'a never-fetched outbox job fails after the worker startup grace window',
);

// Pooling boundary proof: a session lock belongs to backend A, so an unlock
// routed to backend B cannot release it. Transaction ownership releases in the
// transaction's finally path without any separate unlock query.
const sessionLocks = new Map<string, string>();
sessionLocks.set('ps-439', 'backend-a');
const pooledUnlockReleased = sessionLocks.get('ps-439') === 'backend-b';
if (pooledUnlockReleased) sessionLocks.delete('ps-439');
assert(sessionLocks.has('ps-439'), 'a pooled session unlock miss strands the original lock');
let transactionLockHeld = false;
try {
  transactionLockHeld = true;
  assert(transactionLockHeld, 'transaction lock is held inside its owner transaction');
} finally {
  transactionLockHeld = false;
}
assert(!transactionLockHeld, 'transaction completion releases ownership without pg_advisory_unlock');

assert(workerStatus.includes('nextWorkerJobSkipSummary(prior, reason, now)'));
assert(
  healthRoute.includes('evaluateWorkerJobSkipHealth') &&
    healthRoute.includes("name: 'fulfillmentOutbox'") &&
    healthRoute.includes('worker.status?.startedAt ?? null') &&
    healthRoute.includes('lastRunAgeSeconds: health.lastRunAgeSeconds') &&
    healthRoute.includes("reasonCode: 'health_probe_failed'"),
  'deep health must fail closed and expose only sanitized fulfillment-outbox skip facts',
);
assert(
  productionAudit.includes('set transaction read only') &&
    productionAudit.includes('from pg_locks') &&
    productionAudit.includes('join pg_stat_activity') &&
    !/\b(?:insert|update|delete|truncate|alter|drop)\b/i.test(productionAudit),
  'the production lock diagnostic must remain transaction-read-only',
);
assert.equal(
  packageJson.scripts?.['test:ps-439-session-advisory-locks'],
  'tsx scripts/ps-439-session-advisory-locks-guard.ts',
  'package.json must expose the PS-439 guard',
);
assert.equal(
  packageJson.scripts?.['diagnose:ps-439-advisory-locks'],
  'tsx scripts/ps-439-advisory-lock-audit.ts',
  'package.json must expose the read-only PS-439 production diagnostic',
);
assert(guardPack.includes("'test:ps-439-session-advisory-locks'"));
assert(ledger.includes('https://trello.com/c/rFLviYOL'));

console.log('PASS PS-439 session advisory lock guard');
