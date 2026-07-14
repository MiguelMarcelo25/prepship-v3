import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');
const queue = readFileSync('src/services/sync-job-queue.ts', 'utf8');
const rateJobStore = readFileSync('src/services/rate-browse-job-store.ts', 'utf8');

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
  rateJobStore.includes('const rateBrowseJobLockSql = postgres(env.DATABASE_URL'),
  'rate workflow reservation must own a dedicated advisory-lock client',
);

assert(
  rateJobStore.includes('const reserved = await rateBrowseJobLockSql.reserve()'),
  'rate workflow session lock must not reserve the shared application client',
);

assert(
  rateJobStore.includes('pg_advisory_unlock') && rateJobStore.includes('reserved.release()'),
  'rate workflow lock must unlock and release its dedicated connection',
);

console.log('PASS sync advisory lock guard');
