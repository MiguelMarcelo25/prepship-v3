import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');

assert(
  scheduler.includes('const reserved = await pg.reserve()'),
  'sync scheduler must reserve one pooled connection before taking a session advisory lock',
);

assert(
  scheduler.includes('pg_try_advisory_lock'),
  'sync scheduler must take the scheduler advisory lock on the reserved connection',
);

assert(
  scheduler.includes('pg_advisory_unlock'),
  'sync scheduler must unlock the scheduler advisory lock on the reserved connection',
);

assert(
  scheduler.includes('reserved.release()'),
  'sync scheduler must release the reserved connection after unlocking',
);

assert(
  !scheduler.includes('pg_try_advisory_xact_lock'),
  'sync scheduler must not hold a transaction open while external sync work runs',
);

console.log('PASS sync advisory lock guard');
