/**
 * PS-272 closeout guard - bounded sync + stuck reaper proof packet.
 *
 * This is a status/evidence guard, not a production canary. It ties together
 * the focused bounded-sync and reaper proofs, worker queue wiring, and the
 * read-only canary tooling. Runtime worker canary evidence still has to be
 * collected with an approved token after deploy; this guard keeps that status
 * honest instead of turning a code proof into a live proof.
 *
 *   npx tsx scripts/ps-272-bounded-sync-closeout-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function hasScript(pkg: string, script: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${script}"\\s*:\\s*"${escaped}"`).test(pkg);
}

const pkg = read('package.json');
const boundedGuard = read('scripts/ps-272-bounded-sync-drain-guard.ts');
const selectorGuard = read('scripts/ps-272-stuck-job-reaper-guard.ts');
const onPathGuard = read('scripts/ps-272-reaper-onpath-guard.ts');
const syncJobQueue = read('src/services/sync-job-queue.ts');
const stuckReaper = read('src/services/sync-stuck-job-reaper.ts');
const statusSync = read('scripts/status-sync.ts');

check(
  'package.json exposes this closeout guard',
  hasScript(pkg, 'test:ps-272-bounded-sync-closeout', 'tsx scripts/ps-272-bounded-sync-closeout-guard.ts'),
);
check(
  'package.json keeps the focused PS-272 bounded sync guard wired',
  hasScript(pkg, 'test:ps-272-bounded-sync', 'tsx scripts/ps-272-bounded-sync-drain-guard.ts'),
);
check(
  'package.json keeps the PS-272 stuck-job selector guard wired',
  hasScript(pkg, 'test:ps-272-stuck-job-reaper', 'tsx scripts/ps-272-stuck-job-reaper-guard.ts'),
);
check(
  'package.json keeps the PS-272 on-path fake-db reaper guard wired',
  hasScript(pkg, 'test:ps-272-reaper-onpath', 'tsx scripts/ps-272-reaper-onpath-guard.ts'),
);

check(
  'bounded guard proves shipments, orders, and inventory-import are bounded at the service owner',
  /syncShipments creates a per-run budget/.test(boundedGuard) &&
    /syncOrders creates a run-wide budget/.test(boundedGuard) &&
    /MAX_SKUS_PER_RUN SQL LIMIT/.test(boundedGuard),
);
check(
  'bounded guard proves scheduler workers stay thin and delegate without re-owning batch size',
  /queued order worker delegates to the bounded syncOrders service/.test(boundedGuard) &&
    /queued shipment worker delegates to the bounded syncShipments service/.test(boundedGuard) &&
    /runInventoryImportFromOrders delegates to importSkusFromOrders/.test(boundedGuard),
);
check(
  'bounded guard proves fulfillment outbox recovery remains bounded to 25 per tick',
  /processes at most 25 jobs per run/.test(boundedGuard) &&
    /auto-recovers at most 25 missing confirmations per run/.test(boundedGuard),
);

check(
  'selector guard proves classifier is allowed while true side-effect jobs stay excluded',
  /fulfillment-outbox is NOT in REAPER_SAFE_JOB_NAMES/.test(selectorGuard) &&
    /external-shipped-classifier IS in REAPER_SAFE_JOB_NAMES/.test(selectorGuard) &&
    /fees\.walmart-sync is NOT in REAPER_SAFE_JOB_NAMES/.test(selectorGuard),
);
check(
  'on-path guard proves default-off reaper is inert and fake-db ON path updates only selected safe ids',
  /OFF: real reaper returns enabled=false/.test(onPathGuard) &&
    /UPDATE id set is exactly the stuck safe rows/.test(onPathGuard) &&
    /NO real DB, NO network/.test(onPathGuard),
);

check(
  'pg-boss scheduler has its own active-row expiration supervision enabled',
  /supervise: true/.test(syncJobQueue) &&
    /maintenanceIntervalSeconds: 60/.test(syncJobQueue) &&
    /expireInSeconds: 30 \* 60/.test(syncJobQueue),
);
check(
  'queued worker registers the bounded sync workers and schedules the default-off reaper',
  /registerWorker\(JOBS\.orders, async \(jobData, \{ identity, signal \}\) => \{[\s\S]*syncOrders\(\{ \.\.\.options, runIdentity: identity, signal \}\)/.test(syncJobQueue) &&
    /registerWorker\(JOBS\.shipments, \(jobData, \{ signal \}\) =>[\s\S]*syncShipments\(\{ \.\.\.shipmentSyncOptionsFromJobPayload\(jobData\), signal \}\)/.test(syncJobQueue) &&
    /registerWorker\(JOBS\.inventoryImport, runInventoryImportFromOrders\)/.test(syncJobQueue) &&
    /registerWorker\(JOBS\.externalShippedClassifier, runExternalShippedClassifierJob\)/.test(syncJobQueue) &&
    /registerWorker\(JOBS\.queueMaintenance,[\s\S]*reapStuckActiveJobs\(\)[\s\S]*reapStaleQueuedCadenceJobs\(\)/.test(syncJobQueue) &&
    /SCHEDULE_CRON\.everyTenMinutes/.test(syncJobQueue),
);
check(
  'effectful reaper is env-gated default-off and mutates only pgboss job rows',
  /if \(!env\.SYNC_STUCK_JOB_REAPER\)/.test(stuckReaper) &&
    /UPDATE \$\{reaperSql\(jobTable\)\}/.test(stuckReaper) &&
    !/UPDATE\s+(orders|shipments)\b/i.test(stuckReaper),
);

check(
  'read-only canary tooling can check public health, sync status, worker status, and order freshness',
  /\/health/.test(statusSync) &&
    /\/sync\/status/.test(statusSync) &&
    /\/worker\/status/.test(statusSync) &&
    /orders since gap/.test(statusSync),
);
check(
  'read-only canary tooling warns when no approved token is present',
  /Set PREPSHIP_API_TOKEN or SUPABASE_ACCESS_TOKEN/.test(statusSync),
);

const closeoutStatus = {
  card: 'PS-272',
  codeStatus: 'Code/test proof complete',
  runtimeStatus: 'Read-only worker canary pending',
  trelloRecommendation: 'Keep in In Progress until runtime worker evidence is captured',
  safety: 'No queue mutation, live provider call, label/postage purchase, marketplace notification, or production data repair was performed.',
} as const;

check('closeout status keeps PS-272 honest as code/test complete', closeoutStatus.codeStatus === 'Code/test proof complete');
check('closeout status does not claim live worker canary evidence', /pending/.test(closeoutStatus.runtimeStatus));
check('closeout status recommends no Trello move to Done/Final Review yet', /Keep in In Progress/.test(closeoutStatus.trelloRecommendation));
check('closeout status documents no live mutation', /No queue mutation/.test(closeoutStatus.safety));

if (failures > 0) {
  console.error(`\nFAIL PS-272 bounded-sync closeout guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-272 bounded-sync closeout guard');
