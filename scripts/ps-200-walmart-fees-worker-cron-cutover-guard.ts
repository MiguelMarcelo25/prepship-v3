/**
 * PS-200 S3 guard - Walmart fees scheduler is v4-worker owned.
 *
 * Offline/static only: no DB, no network, no Walmart calls, no order writes.
 * This pins the legacy Vercel cron cutover without running the job.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function missingTokens(source: string, tokens: string[]): string[] {
  return tokens.filter((token) => !source.includes(token));
}

const vercel = JSON.parse(read('vercel.json')) as {
  crons?: unknown;
  rewrites?: Array<{ source?: string; destination?: string }>;
};
const packageJson = read('package.json');
const ps200Doc = read('docs/ps-200-legacy-api-decommission.md');
const staleExclusionGuard = read('scripts/ps-200-stale-exclusion-slice-guard.ts');
const syncScheduler = read('src/services/sync-scheduler.ts');
const syncJobQueue = read('src/services/sync-job-queue.ts');
const syncCadence = read('src/lib/sync-cadence.ts');
const env = read('src/lib/env.ts');
const cronRoute = read('src/routes/cron.ts');
const walmartFeesConnector = read('src/connectors/store/walmart-fees.ts');
const workerEntry = read('src/worker.ts');

const apiRewrite = (vercel.rewrites ?? []).find(
  (rewrite) => typeof rewrite.source === 'string' && rewrite.source.startsWith('/api/:path'),
);
const apiRewriteSource = apiRewrite?.source ?? '';

check('legacy Vercel api/cron folder is gone',
  !existsSync('api/cron') && !existsSync('api/cron/sync-walmart-fees.ts'));

check('vercel.json has no Vercel crons block',
  !('crons' in vercel));

check('vercel /api rewrite no longer excludes cron/ from Render proxy',
  apiRewriteSource.length > 0 &&
  /onrender\.com/.test(apiRewrite?.destination ?? '') &&
  !apiRewriteSource.includes('cron/'));

check('vercel /api rewrite still keeps non-S3 exclusions blocked',
  missingTokens(apiRewriteSource, ['carrier-accounts', 'carriers/', 'store-accounts', 'oauth/', 'admin/']).length === 0,
  missingTokens(apiRewriteSource, ['carrier-accounts', 'carriers/', 'store-accounts', 'oauth/', 'admin/']));

check('Render cron route is mounted and protected by CRON_SECRET',
  cronRoute.includes('const app = new Hono()') &&
  cronRoute.includes('env.CRON_SECRET') &&
  cronRoute.includes('x-cron-secret'));

check('sync-scheduler owns the daily Walmart fees tick',
  missingTokens(syncScheduler, [
    "import { syncWalmartFeesAllAccounts } from '../connectors/store/walmart-fees';",
    'const WALMART_FEES_INTERVAL_MS = SYNC_CADENCE_MS.walmartFees',
    'export async function runWalmartFeesTick()',
    'syncWalmartFeesAllAccounts(pg, fromDate, toDate)',
    'env.ENABLE_WALMART_FEES_SCHEDULER',
    'walmartFeesTimer = setTimeout',
    'walmartFeesTimer = setInterval',
  ]).length === 0,
  missingTokens(syncScheduler, [
    "import { syncWalmartFeesAllAccounts } from '../connectors/store/walmart-fees';",
    'const WALMART_FEES_INTERVAL_MS = SYNC_CADENCE_MS.walmartFees',
    'export async function runWalmartFeesTick()',
    'syncWalmartFeesAllAccounts(pg, fromDate, toDate)',
    'env.ENABLE_WALMART_FEES_SCHEDULER',
    'walmartFeesTimer = setTimeout',
    'walmartFeesTimer = setInterval',
  ]));

check('sync-job-queue registers and schedules the same Walmart fees tick',
  missingTokens(syncJobQueue, [
    'runWalmartFeesTick',
    "walmartFees: 'prepship.fees.walmart-sync'",
    'const WALMART_FEES_INTERVAL_MS = SYNC_CADENCE_MS.walmartFees',
    'await registerWorker(JOBS.walmartFees, runWalmartFeesTick)',
    'scheduleEnqueue(',
    'JOBS.walmartFees',
    'env.ENABLE_WALMART_FEES_SCHEDULER',
  ]).length === 0,
  missingTokens(syncJobQueue, [
    'runWalmartFeesTick',
    "walmartFees: 'prepship.fees.walmart-sync'",
    'const WALMART_FEES_INTERVAL_MS = SYNC_CADENCE_MS.walmartFees',
    'await registerWorker(JOBS.walmartFees, runWalmartFeesTick)',
    'scheduleEnqueue(',
    'JOBS.walmartFees',
    'env.ENABLE_WALMART_FEES_SCHEDULER',
  ]));

check('daily cadence is centralized in sync-cadence',
  /walmartFees:\s*24 \* 60 \* 60 \* 1000/.test(syncCadence) &&
  /legacy Vercel cron/.test(syncCadence));

check('Walmart fees scheduler flag is a default-on kill switch',
  /ENABLE_WALMART_FEES_SCHEDULER:\s*booleanFlag\(true\)/.test(env) &&
  /kill-switch/.test(env));

check('worker entry can start pg-boss or interval scheduler on the worker process',
  workerEntry.includes('startQueuedSyncScheduler') &&
  workerEntry.includes('startSyncScheduler') &&
  workerEntry.includes('USE_PG_BOSS_SCHEDULER'));

check('Walmart fees connector remains the provider API owner',
  walmartFeesConnector.includes('marketplace.walmartapis.com') &&
  walmartFeesConnector.includes('syncWalmartFeesForAccount') &&
  walmartFeesConnector.includes('syncWalmartFeesAllAccounts'));

check('PS-200 doc marks S3 done and wired to this guard',
  /S3/.test(ps200Doc) &&
  /test:ps-200-walmart-fees-worker-cron-cutover/.test(ps200Doc) &&
  /Done locally/.test(ps200Doc));

check('PS-200 stale exclusion guard no longer preserves cron/ as blocked',
  !/for \(const live of \[[^\]]*cron\//.test(staleExclusionGuard) &&
  /cron\/.*removed/i.test(staleExclusionGuard));

check('package wires PS-200 S3 guard',
  packageJson.includes('"test:ps-200-walmart-fees-worker-cron-cutover"'));

if (failures > 0) {
  console.error(`\nFAIL PS-200 Walmart fees worker cron cutover guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-200 Walmart fees worker cron cutover guard');
