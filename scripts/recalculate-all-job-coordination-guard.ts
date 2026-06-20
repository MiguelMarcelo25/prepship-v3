/**
 * Recalculate All job coordination guard.
 *
 * Pins the failure modes from the 2026-06-20 audit:
 * - Manual Recalculate All (maxAgeHours: 0) must not attach to an active
 *   cache-friendly/passive job. It must queue as force-live and run next.
 * - The UI poller must not swallow missing/failed status forever; it must stop
 *   the local loading state and surface a retryable error.
 *
 *   npx tsx scripts/recalculate-all-job-coordination-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>;
};

check(
  'package exposes the Recalculate All coordination guard',
  packageJson.scripts?.['test:recalculate-all-job-coordination'] ===
    'tsx scripts/recalculate-all-job-coordination-guard.ts',
);

check(
  'backfill job carries an explicit mode',
  /export type BackfillJobMode = 'manual_force_live' \| 'cache_friendly'/.test(backfill) &&
    /mode: BackfillJobMode/.test(backfill),
);

check(
  'manual force-live queues behind an active passive cache-friendly job',
  /queuedBackfillRequests/.test(backfill) &&
    /requestedMode === 'manual_force_live'/.test(backfill) &&
    /activeMode === 'cache_friendly'/.test(backfill) &&
    /queued behind active cache-friendly backfill/i.test(backfill),
);

check(
  'finished active job starts the queued force-live backfill',
  /startQueuedBackfillIfIdle/.test(backfill) &&
    /finally[\s\S]*startQueuedBackfillIfIdle/.test(backfill),
);

check(
  'job status endpoint can recover the requested durable per-job snapshot',
  /RATE_BACKFILL_JOB_STATUS_KEY_PREFIX/.test(backfill) &&
    /getBackfillJobSnapshot\(jobId/.test(backfill) &&
    /app\.get\('\/backfill-best\/status\/:jobId'[\s\S]*getBackfillJobSnapshot\(jobId\)/.test(
      readFileSync('src/routes/rates.ts', 'utf8'),
    ),
);

check(
  'Recalculate All poller stops instead of swallowing repeated status failures forever',
  /recalcAllPollFailures/.test(ordersView) &&
    /setRecalcAllJobId\(null\)/.test(ordersView) &&
    /Recalculate All status unavailable/.test(ordersView),
);

if (failures > 0) {
  console.error(`\nFAIL Recalculate All job coordination guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS Recalculate All job coordination guard');
