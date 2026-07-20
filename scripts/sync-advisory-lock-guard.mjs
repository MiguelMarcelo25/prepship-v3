import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');
const queue = readFileSync('src/services/sync-job-queue.ts', 'utf8');
const rateJobStore = readFileSync('src/services/rate-browse-job-store.ts', 'utf8');
const durableWorkerMigration = readFileSync(
  'drizzle/0067_durable_worker_execution_fences.sql',
  'utf8',
);

// Per user override unlock shipped data on 2026-07-14: these assertions cover
// coordination clients only; no order, shipment, label, or inventory mutation.
assert(
  queue.includes('withSyncLaneAdvisoryLock(lane, async () =>'),
  'durable queue must remain the canonical cross-process sync admission owner',
);

assert(
  !scheduler.includes('pg.reserve()') && !scheduler.includes('pg_try_advisory_lock'),
  'scheduler handlers must not take a second lock through the application pool',
);

assert(
  !rateJobStore.includes('postgres(') && !rateJobStore.includes('.reserve()'),
  'rate workflow reservation must not own a session-held advisory-lock client',
);

assert(
  durableWorkerMigration.includes(
    'CREATE UNIQUE INDEX IF NOT EXISTS rate_browse_jobs_request_active_unq',
  ) &&
    durableWorkerMigration.includes(
      'WHERE active = true AND request_key IS NOT NULL',
    ),
  'rate workflow reservation must use the durable unique active-request fence',
);

assert(
  rateJobStore.includes("code !== '23505'") &&
    rateJobStore.includes('getActiveRateBrowseJobRecordByRequestKey(requestKey)'),
  'rate workflow reservation must converge unique conflicts on the durable active record',
);

console.log('PASS sync advisory lock guard');
