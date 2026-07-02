import { readFileSync } from 'node:fs';

let failures = 0;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, ok: boolean): void {
  if (ok) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

function extractRouteBlock(source: string): string {
  const start = source.indexOf("app.post('/orders'");
  if (start === -1) return '';
  const end = source.indexOf("app.get('/status'", start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

const syncRoute = read('src/routes/sync.ts');
const syncRouteBlock = extractRouteBlock(syncRoute);
const queue = read('src/services/sync-job-queue.ts');
const payload = read('src/services/manual-order-sync-job.ts');
const client = read('web/src/lib/v2-apiClient.ts');
const home = read('web/src/Home.tsx');

check(
  '/sync/orders imports the backend queue owner',
  /import \{ enqueueManualOrderSyncJob, getSyncJobQueueStatus \} from '\.\.\/services\/sync-job-queue';/.test(syncRoute),
);
check(
  '/sync/orders no longer imports order-sync or rates-backfill work',
  !/import \{[^}]*syncOrders/.test(syncRoute) && !/from '\.\.\/services\/rates-backfill'/.test(syncRoute),
);
check(
  '/sync/orders delegates to enqueueManualOrderSyncJob',
  /const result = await enqueueManualOrderSyncJob\(body\);/.test(syncRouteBlock),
);
check(
  '/sync/orders does not run syncOrders inline',
  !/syncOrders\(/.test(syncRouteBlock) && !/startBackfillBestRates\(/.test(syncRouteBlock),
);
check(
  '/sync/orders returns accepted queued state instead of completed sync totals',
  /return c\.json\(response, result\.error \? 503 : 202\);/.test(syncRouteBlock) &&
    /already_queued/.test(syncRouteBlock),
);

check(
  'manual order-sync payload owner exports request-to-job translation',
  /export function buildManualOrderSyncJobPayload/.test(payload) &&
    /export function orderSyncOptionsFromJobPayload/.test(payload),
);
check(
  'manual full sync preserves fullResync as sinceMs zero',
  /fullResync\s*\?\s*0/.test(payload) && /payload\.fullResync = true/.test(payload),
);

check(
  'sync-job-queue exposes a manual enqueue helper for the order job',
  /export async function enqueueManualOrderSyncJob/.test(queue) &&
    /JOBS\.orders/.test(queue) &&
    /singletonKey: `manual-\$\{payload\.mode\}`/.test(queue),
);
check(
  'manual enqueue uses transient pg-boss from API process when worker queue is external',
  /application_name: 'prepship-api-manual-order-sync'/.test(queue) &&
    /await transientBoss\.createQueue\(JOBS\.orders/.test(queue),
);
check(
  'queued order worker consumes job payload instead of ignoring manual options',
  /await registerWorker\(JOBS\.orders, async \(jobData\) => \{/.test(queue) &&
    /syncOrders\(orderSyncOptionsFromJobPayload\(jobData\)\)/.test(queue),
);
check(
  'queued order worker preserves backend rate backfill handoff after changed orders',
  /result\.synced > 0 && isRateBackfillSchedulerEnabled\(\)/.test(queue) &&
    /runBackfillTick\(\);/.test(queue),
);

check(
  'frontend trigger posts manual full sync intent to /sync/orders',
  /api\.post<any>\(\s*'\/sync\/orders',\s*mode === 'full' \? \{ full: true, fullResync: true \} : \{\}/.test(client),
);
check(
  'frontend handles queued/already queued response before completed-sync fallback',
  /result\?\.queued \|\| result\?\.status === 'already_queued'/.test(home) &&
    /applyQueuedSync\('incremental', result\)/.test(home) &&
    /applyQueuedSync\('full', result\)/.test(home),
);

if (failures > 0) {
  console.error(`\nFAIL PS-356 manual order sync job-lane guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-356 manual order sync job-lane guard');
