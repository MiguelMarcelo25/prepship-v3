import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');
const queue = readFileSync('src/services/sync-job-queue.ts', 'utf8');
const rateJobStore = readFileSync('src/services/rate-browse-job-store.ts', 'utf8');
const dbClient = readFileSync('src/db/client.ts', 'utf8');

// The durable queue is the canonical cross-process admission owner. A handler
// must not reserve the shared application pool for a second advisory lock:
// production intentionally supports DB_POOL_MAX=1, so the handler's first DB
// query would otherwise wait forever behind its own reserved connection.
assert.match(
  queue,
  /withSyncLaneAdvisoryLock\(lane,\s*async\s*\(\)\s*=>\s*\{/,
  'durable queue retains canonical cross-process lane admission',
);
assert.doesNotMatch(
  scheduler,
  /pg\.reserve\(\)|pg_try_advisory_lock|pg_advisory_unlock/,
  'scheduler handlers never reserve the shared DB pool for duplicate admission',
);
assert.doesNotMatch(
  scheduler,
  /activeSchedulerJobsByLane|getSyncJobLaneBlocker|syncJobLaneFor/,
  'scheduler handlers do not maintain a second lane-admission owner',
);
assert.doesNotMatch(
  scheduler,
  /recordWorkerJob(?:Start|Success|Failure|Skipped)/,
  'worker job lifecycle is recorded once by the durable queue owner',
);
assert.match(
  scheduler,
  /async function runSchedulerJob<T>\([\s\S]*?return await fn\(\);[\s\S]*?finished in/,
  'scheduler helper executes admitted work without taking another connection',
);
assert.match(
  scheduler,
  /runFulfillmentOutboxTick[\s\S]*?runSchedulerJob\('fulfillment outbox'/,
  'fulfillment outbox uses the non-locking admitted-work helper',
);

// The rate refresh started after a successful order sync has the same
// single-pool constraint. Its session advisory lock must use a dedicated lock
// client before it rechecks/persists the workflow through the application pool.
assert.doesNotMatch(
  rateJobStore,
  /const reserved = await pg\.reserve\(\)/,
  'rate workflow reservation never holds the only application DB connection',
);
assert.match(
  rateJobStore,
  /const rateBrowseJobLockSql = postgres\(env\.DATABASE_URL,[\s\S]*?max: 1/,
  'rate workflow reservation owns a one-connection dedicated lock client',
);
assert.match(
  rateJobStore,
  /const reserved = await rateBrowseJobLockSql\.reserve\(\)/,
  'rate workflow advisory lock uses the dedicated lock client',
);

assert.match(
  dbClient,
  /const transactionPoolerCompatibility = \{ max_pipeline: 1 \}/,
  'Supabase transaction-pooler queries are serialized per application connection',
);
assert.match(
  dbClient,
  /prepare: false,[\s\S]*?\.\.\.transactionPoolerCompatibility/,
  'the shared database client disables prepared statements and deep pipelining for the transaction pooler',
);

console.log('PASS sync scheduler single-pool deadlock guard');
