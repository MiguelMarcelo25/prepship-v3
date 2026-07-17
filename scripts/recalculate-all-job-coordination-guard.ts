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
const producer = readFileSync('src/services/rate-backfill-job-producer.ts', 'utf8');
const jobTypes = readFileSync('src/services/rate-backfill-job-types.ts', 'utf8');
const queue = readFileSync('src/services/sync-job-queue.ts', 'utf8');
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
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
  'manual force-live enters the durable worker queue ahead of passive rate work but below operational sync',
  /enqueueBackfillBestRates\(body, 'manual'\)/.test(ratesRoute) &&
    /priority: rateBackfillPriority\(payload\)/.test(producer) &&
    /RATE_BACKFILL_MANUAL_PRIORITY = -10/.test(jobTypes) &&
    /RATE_BACKFILL_YIELD_PRIORITY = -100/.test(jobTypes) &&
    /id: payload\.jobId/.test(producer),
);

check(
  'durable worker executes explicit payloads and awaits their full lifetime',
  /parseDurableRateBackfillJobPayload\(jobData\)/.test(queue) &&
    /runDurableRateBackfillJob\(explicitRequest, signal\)/.test(queue) &&
    /await waitForBackfillJob\(job\.jobId\)/.test(backfill),
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
