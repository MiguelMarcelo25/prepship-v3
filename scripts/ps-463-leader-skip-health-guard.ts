/**
 * PS-463 provider-free leadership and health boundary guard.
 *
 * Uses synthetic timestamps and connection strings only. It never connects to
 * Postgres, starts a queue consumer, calls ShipStation, or sends a marketplace
 * confirmation.
 */
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:1/prepship_guard';
process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const {
  WORKER_JOB_STALE_AFTER_MS,
  evaluateWorkerJobSkipHealth,
  nextWorkerJobSkipSummary,
} = await import('../src/services/worker-job-skip-health');
const { resolveShipStationConsumerLeaderDatabaseUrl } = await import(
  '../src/services/sync-job-queue'
);

const startedAt = '2026-07-22T00:00:00.000Z';
const first = nextWorkerJobSkipSummary(null, 'orders already running', startedAt);
const second = nextWorkerJobSkipSummary(
  { status: 'skipped', summary: first },
  first.reason,
  '2026-07-22T00:01:00.000Z',
);
const third = nextWorkerJobSkipSummary(
  { status: 'skipped', summary: second },
  first.reason,
  '2026-07-22T00:02:00.000Z',
);

assert.equal(WORKER_JOB_STALE_AFTER_MS, 3 * 60_000);
assert.equal(
  evaluateWorkerJobSkipHealth(
    { status: 'skipped', finishedAt: '2026-07-22T00:02:00.000Z', summary: third },
    Date.parse('2026-07-22T00:02:00.000Z'),
  ).status,
  'ok',
  'three rapid lane skips during a healthy walk must not fail deep health',
);
assert.equal(
  evaluateWorkerJobSkipHealth(
    { status: 'skipped', finishedAt: '2026-07-22T00:04:00.001Z', summary: third },
    Date.parse('2026-07-22T00:04:00.001Z'),
  ).reasonCode,
  'persistent_skip',
  'one unchanged skip state beyond the cadence budget must fail health',
);
assert.equal(
  evaluateWorkerJobSkipHealth(
    { status: 'succeeded', finishedAt: startedAt, summary: null },
    Date.parse('2026-07-22T00:04:00.001Z'),
  ).reasonCode,
  'job_stale',
  'a stale success cannot hide a consumer-leader halt',
);
assert.equal(
  evaluateWorkerJobSkipHealth(
    undefined,
    Date.parse('2026-07-22T00:04:00.001Z'),
    startedAt,
  ).reasonCode,
  'job_stale',
  'a never-fetched job fails after the worker startup grace period',
);

assert.equal(
  resolveShipStationConsumerLeaderDatabaseUrl({
    databaseUrl:
      'postgresql://postgres.ref:secret@aws-1-us.pooler.supabase.com:6543/postgres',
  }),
  'postgresql://postgres.ref:secret@aws-1-us.pooler.supabase.com:5432/postgres',
  'the legacy transaction-pooler URL is converted to its sticky session-mode port',
);
assert.equal(
  resolveShipStationConsumerLeaderDatabaseUrl({
    databaseUrl: 'postgresql://app:secret@app.example:5432/postgres',
    dedicatedDatabaseUrl: 'postgresql://leader:secret@db.example:5432/postgres',
  }),
  'postgresql://leader:secret@db.example:5432/postgres',
  'an explicit dedicated leadership URL wins',
);
assert.equal(
  resolveShipStationConsumerLeaderDatabaseUrl({
    databaseUrl: 'postgresql://app:secret@app.example:6543/postgres',
  }),
  'postgresql://app:secret@app.example:6543/postgres',
  'a non-Supabase custom port is not rewritten by a provider-specific rule',
);
assert.throws(
  () => resolveShipStationConsumerLeaderDatabaseUrl({
    databaseUrl: 'postgresql://app:secret@app.example:5432/postgres',
    dedicatedDatabaseUrl:
      'postgresql://postgres.ref:secret@aws-1-us.pooler.supabase.com:6543/postgres',
  }),
  /cannot use the Supabase transaction pooler/,
  'an explicit transaction-pooler leadership URL must fail closed',
);

console.log('PASS PS-463 leader-election and skip-health guard');
