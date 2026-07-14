import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const envSource = readFileSync('src/lib/env.ts', 'utf8');
const syncScheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');
const jobQueue = readFileSync('src/services/sync-job-queue.ts', 'utf8');
const reconcile = readFileSync('scripts/reconcile-external-shipped-orders.ts', 'utf8');
const syncCadence = readFileSync('src/lib/sync-cadence.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert.match(
  envSource,
  /ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER/,
  'env must expose explicit opt-in for automatic external-shipped classification.',
);
assert.match(
  envSource,
  /ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY/,
  'env must expose separate explicit opt-in for automatic reversible flag apply.',
);
assert.match(
  envSource,
  /EXTERNAL_SHIPPED_CLASSIFIER_LOOKBACK_DAYS[\s\S]*\.min\(30\)[\s\S]*\.default\(30\)/,
  'env must expose a 30+ day automatic external-shipped lookback so Cancelled-table leftovers are not missed.',
);
assert.match(
  reconcile,
  /export async function runExternalShippedReconcile/,
  'external-shipped script must export an in-process runner for the scheduler.',
);
assert.match(
  syncScheduler,
  /runExternalShippedClassifierTick/,
  'handler module must include an external-shipped classifier tick.',
);
assert.match(
  syncScheduler,
  /runExternalShippedClassifierJob/,
  'scheduler must expose a direct bounded classifier job for queued workers.',
);
assert.match(
  syncScheduler,
  /includeCancelled: true/,
  'automatic classifier must include cancelled rows per PS-056 follow-up.',
);
assert.match(
  syncCadence,
  /externalShippedClassifier:\s*3\s*\*\s*60\s*\*\s*1000/,
  'automatic classifier must run on the same 3-minute cadence as the visible sync loop.',
);
assert.match(
  syncScheduler,
  /limit: EXTERNAL_SHIPPED_CLASSIFIER_LIMIT/,
  'automatic classifier must use bounded batches instead of large timeout-prone sweeps.',
);
assert.match(
  syncScheduler,
  /lookupTimeoutMs: EXTERNAL_SHIPPED_CLASSIFIER_LOOKUP_TIMEOUT_MS/,
  'automatic classifier must bound each upstream ShipStation lookup.',
);
assert.match(
  syncScheduler,
  /timeBudgetMs: EXTERNAL_SHIPPED_CLASSIFIER_TIME_BUDGET_MS/,
  'automatic classifier must return before the worker job deadline.',
);
assert.match(
  syncScheduler,
  /days: env\.EXTERNAL_SHIPPED_CLASSIFIER_LOOKBACK_DAYS/,
  'automatic classifier must use the configured 30+ day lookback, not a hardcoded 7-day window.',
);
assert.match(
  syncScheduler,
  /apply: env\.ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY === true/,
  'automatic apply must require ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY=true.',
);
assert.match(
  jobQueue,
  /JOBS\.externalShippedClassifier,[\s\S]*SCHEDULE_CRON\.everyThreeMinutes/,
  'pg-boss scheduler must durably schedule the external-shipped classifier job.',
);
assert.match(
  jobQueue,
  /registerWorker\(JOBS\.externalShippedClassifier, runExternalShippedClassifierJob\)/,
  'pg-boss classifier worker must call the bounded job directly, not the legacy interval lock wrapper.',
);
assert.equal(
  pkg.scripts['test:ps-056-auto-external-shipped'],
  'node scripts/ps-056-auto-external-shipped-scheduler-guard.mjs',
  'package.json must expose the PS-056 automatic scheduler guard.',
);

console.log('PASS PS-056 automatic external-shipped scheduler guard');
