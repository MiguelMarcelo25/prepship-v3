import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');

assert(
  scheduler.includes('pg_try_advisory_xact_lock'),
  'sync scheduler must use transaction-scoped advisory locks so pooled connections cannot leak scheduler locks',
);

assert(
  !scheduler.includes('pg_try_advisory_lock(hashtext'),
  'sync scheduler must not use session-scoped pg_try_advisory_lock with pooled connections',
);

assert(
  !scheduler.includes('pg_advisory_unlock(hashtext'),
  'sync scheduler must not rely on session-scoped pg_advisory_unlock with pooled connections',
);

console.log('PASS sync advisory lock guard');
