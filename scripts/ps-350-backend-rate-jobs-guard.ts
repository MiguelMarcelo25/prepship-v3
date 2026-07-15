/**
 * PS-350 - backend rate jobs: cache-first, partial results, shared-limited provider calls.
 *
 * Offline/static only: no DB, no provider calls, no labels, no queue mutation.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const packageJson = read('package.json');
const workflowKeyPath = 'src/services/rate-browse-workflow-key.ts';
const jobStorePath = 'src/services/rate-browse-job-store.ts';
const workflowStorePath = 'src/services/rate-browse-workflow-store.ts';
const workflowServicePath = 'src/services/rate-browse-workflow.ts';
const producerPath = 'src/services/rate-browse-response-producer.ts';
const routesPath = 'src/routes/rates.ts';
const backfillPath = 'src/services/rates-backfill.ts';
const durableLimiterPath = 'src/lib/shipstation/durable-rate-limiter.ts';
const runtimeDdlGuardPath = 'scripts/runtime-ddl-guard.mjs';
const runtimeDdlAuditPath = 'RUNTIME_DDL_MIGRATION_AUDIT.md';
const docPath = 'docs/ps-tickets/ps-350-backend-rate-jobs.md';
const ps352Path = 'docs/ps-tickets/ps-352-shipping-workflow-sot-map.md';

const workflowKey = read(workflowKeyPath);
const jobStore = read(jobStorePath);
const workflowStore = read(workflowStorePath);
const workflowService = read(workflowServicePath);
const producer = read(producerPath);
const routes = read(routesPath);
const backfill = read(backfillPath);
const durableLimiter = read(durableLimiterPath);
const runtimeDdlGuard = read(runtimeDdlGuardPath);
const runtimeDdlAudit = read(runtimeDdlAuditPath);
const doc = read(docPath);
const ps352 = read(ps352Path);
const runtimeSchemaMigration = read('drizzle/0062_runtime_schema_ownership.sql');

check(
  'PS-350 package guard is wired',
  packageJson.includes('"test:ps-350-backend-rate-jobs": "tsx scripts/ps-350-backend-rate-jobs-guard.ts"'),
);

check(
  'rate browse workflow request-key owner exists and produces stable backend job keys',
  existsSync(workflowKeyPath) &&
    /export function buildRateBrowseWorkflowRequestKey\(body: Record<string, unknown>\): string/.test(workflowKey) &&
    /createHash\('sha256'\)/.test(workflowKey) &&
    /stableWorkflowValue/.test(workflowKey) &&
    /rate-browse-workflow:/.test(workflowKey),
);

check(
  'migration owns durable rate jobs and store verifies readiness',
  existsSync(jobStorePath) &&
    /CREATE TABLE IF NOT EXISTS rate_browse_jobs/.test(runtimeSchemaMigration) &&
    /job_id text PRIMARY KEY/.test(runtimeSchemaMigration) &&
    /request_key text/.test(runtimeSchemaMigration) &&
    /priority text NOT NULL DEFAULT 'manual'/.test(runtimeSchemaMigration) &&
    /snapshot jsonb NOT NULL/.test(runtimeSchemaMigration) &&
    /CREATE TABLE IF NOT EXISTS rate_browse_job_provider_statuses/.test(runtimeSchemaMigration) &&
    /provider_key text NOT NULL/.test(runtimeSchemaMigration) &&
    /diagnostics jsonb NOT NULL DEFAULT '\{\}'::jsonb/.test(runtimeSchemaMigration) &&
    /CREATE INDEX IF NOT EXISTS rate_browse_jobs_request_active_idx/.test(runtimeSchemaMigration) &&
    /ALTER TABLE rate_browse_jobs ENABLE ROW LEVEL SECURITY/.test(runtimeSchemaMigration) &&
    /assertRuntimeSchemaReady/.test(jobStore),
);

check(
  'job store serializes duplicate live workflow reservation by durable request key',
  /import \{ advisoryLockKeyPair \} from ['"]\.\.\/lib\/advisory-lock['"]/.test(jobStore) &&
    /export async function reserveRateBrowseJobRecord/.test(jobStore) &&
    /acquireRateBrowseJobReservationLock/.test(jobStore) &&
    /pg_advisory_lock/.test(jobStore) &&
    !/pg_try_advisory_lock|lock_busy_starting_independent_job/.test(jobStore) &&
    /getActiveRateBrowseJobRecordByRequestKey/.test(jobStore) &&
    /created: false/.test(jobStore) &&
    /created: true/.test(jobStore),
);

check(
  'rate browse schema delegates to the shared boot gate',
  /ensureRateBrowseJobStoreSchema/.test(jobStore) &&
    /assertRuntimeSchemaReady/.test(jobStore) &&
    !/CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(jobStore),
);

check(
  'job store persists per-provider diagnostics from backend carrier statuses and timing rows',
  /export function extractRateBrowseProviderStatuses/.test(jobStore) &&
    /carrierStatuses/.test(jobStore) &&
    /rateBrowseTiming/.test(jobStore) &&
    /duration_ms/.test(jobStore) &&
    /limiter_wait_ms/.test(jobStore) &&
    /persistRateBrowseProviderStatuses/.test(jobStore) &&
    /ON CONFLICT \(job_id, provider_key\) DO UPDATE SET/.test(jobStore),
);

check(
  'workflow store uses the durable job store first and keeps settings only as a legacy fallback',
  /from ['"]\.\/rate-browse-job-store['"]/.test(workflowStore) &&
    /reserveRateBrowseJobRecord/.test(workflowStore) &&
    /persistRateBrowseJobRecord/.test(workflowStore) &&
    /getRateBrowseJobRecord/.test(workflowStore) &&
    /getJsonSetting/.test(workflowStore) &&
    /setJsonSettings/.test(workflowStore) &&
    /const durable = await getRateBrowseJobRecord\(jobId\)/.test(workflowStore) &&
    /if \(durable\) return durable/.test(workflowStore),
);

check(
  'workflow store fails reservation closed while retaining legacy status diagnostics',
  /durableFallbackSnapshot/.test(workflowStore) &&
    /durableReservationFailureSnapshot/.test(workflowStore) &&
    /durableStore: 'fallback'/.test(workflowStore) &&
    /provider work was not started/.test(workflowStore) &&
    /created: false/.test(workflowStore) &&
    /durable persist failed; falling back to settings snapshot/.test(workflowStore),
);

check(
  'workflow service computes a durable request key, attaches to existing jobs, and only runs newly-created jobs',
  /buildRateBrowseWorkflowRequestKey/.test(workflowService) &&
    /priority\?: 'manual' \| 'preflight' \| 'backfill'/.test(workflowService) &&
    /reserveRateBrowseWorkflowSnapshot/.test(workflowService) &&
    /if \(reservation\.created\) \{[\s\S]{0,300}scheduleDetachedRateBrowseJob/.test(workflowService) &&
    /return reservation\.snapshot/.test(workflowService),
);

check(
  'routes mark explicit Rate Browser work as manual priority while keeping frontend as a thin renderer',
  /priority: 'manual'/.test(routes) &&
    /startRateBrowseWorkflow\(\{[\s\S]{0,600}run: \(\) => produceRateBrowsePayload/.test(routes) &&
    /publicRateBrowseWorkflowSnapshot/.test(routes),
);

check(
  'ranking/proof still live only in the backend rate browse producer, not the job store',
  /combineCarrierUniverses/.test(producer) &&
    /finalizeBestRateWithQuote/.test(producer) &&
    /buildBestRateWorkflowDto/.test(producer) &&
    !/combineCarrierUniverses|rateTotal|finalizeBestRateWithQuote|selectedRateOpaqueKey/.test(jobStore),
);

check(
  'shared provider limiter evidence remains backend-owned and durable-capable',
  /CREATE TABLE IF NOT EXISTS rate_limiter_state/.test(runtimeSchemaMigration) &&
    /assertRuntimeSchemaReady/.test(durableLimiter) &&
    /UPDATE rate_limiter_state[\s\S]*RETURNING tokens/.test(durableLimiter) &&
    /RATE_LIMITER_BACKEND=durable/.test(doc),
);

check(
  'background backfill remains explicitly lower-priority than manual rate browse in the PS-350 documentation',
  /Manual Rate Browser and Print Queue preflight outrank background backfill/.test(doc) &&
    /background backfill/.test(backfill),
);

check(
  'migration-readiness audit documents the PS-350 rate job store',
  runtimeDdlGuard.includes("'src/services/rate-browse-job-store.ts'") &&
    runtimeDdlAudit.includes('src/services/rate-browse-job-store.ts') &&
    runtimeDdlAudit.includes('rate_browse_jobs') &&
    runtimeDdlAudit.includes('rate_browse_job_provider_statuses'),
);

check(
  'PS-350 doc records backend owner, imperfect data injection, route contract, safety, and remaining canary proof',
  existsSync(docPath) &&
    doc.includes('Backend Owner') &&
    doc.includes('Imperfect Data Injection') &&
    doc.includes('Route Contract') &&
    doc.includes('Safety') &&
    doc.includes('No labels, postage, provider calls, queue mutation, billing, inventory, or shipped/cancelled mutation') &&
    doc.includes('Remaining canary proof'),
);

check(
  'PS-352 map points PS-350 to the durable backend rate job owner',
  ps352.includes('PS-350 durable rate browse job store') &&
    ps352.includes('rate_browse_jobs') &&
    ps352.includes('rate_browse_job_provider_statuses'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-350 backend rate jobs guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-350 backend rate jobs guard');
