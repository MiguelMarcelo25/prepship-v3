/**
 * PS-360 stale cadence reaper guard.
 *
 * Cadence/busy-defer sync jobs are watermark-based. If the worker is down or
 * wedged, old `created` sync ticks become redundant backlog and can starve
 * current shipment work. The queue owner may fail old redundant queued rows;
 * active fulfillment/fee side-effect jobs remain excluded from stuck-active reaping.
 */
import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const reaper = read('src/services/sync-stuck-job-reaper.ts');
const queue = read('src/services/sync-job-queue.ts');
const pkg = read('package.json');

check('reaper exports stale queued cadence age threshold',
  /REAPER_STALE_QUEUED_MIN_AGE_MS\s*=\s*15 \* 60_000/.test(reaper));
check('reaper keeps the newest cadence row per safe job',
  /REAPER_STALE_QUEUED_KEEP_PER_JOB\s*=\s*1/.test(reaper) &&
  /PARTITION BY name, logical_singleton_key/.test(reaper));
check('stale queued reaper ranks all queued ticks before applying stale cutoff',
  /created_on,\s*row_number\(\) OVER/.test(reaper) &&
  /WHERE newest_rank > \$\{REAPER_STALE_QUEUED_KEEP_PER_JOB\}\s*AND created_on < now\(\)/.test(reaper));
check('stale cadence reaper only considers created/retry rows',
  /state IN \('created', 'retry'\)/.test(reaper));
check('stale queued reaper only considers safe sync singleton rows',
  /REAPER_STALE_QUEUED_SINGLETON_KEYS/.test(reaper) &&
  /'cadence'/.test(reaper) &&
  /'busy-defer'/.test(reaper) &&
  /'manual-incremental'/.test(reaper) &&
  /'watchdog-recovery'/.test(reaper) &&
  /ORDER_REFRESH_SINGLETON_KEY/.test(reaper) &&
  /SHIPMENT_REFRESH_SINGLETON_KEY/.test(reaper) &&
  /singleton_key = ANY\(\$\{REAPER_STALE_QUEUED_SINGLETON_KEYS as string\[\]\}\)/.test(reaper));
check('legacy producer keys are ranked as one logical ShipStation refresh',
  /LEGACY_ORDER_REFRESH_SINGLETON_KEYS/.test(reaper) &&
  /LEGACY_SHIPMENT_REFRESH_SINGLETON_KEYS/.test(reaper) &&
  /END AS logical_singleton_key/.test(reaper));
check('stale queued reaper collapses old manual refresh ticks',
  /LEGACY_ORDER_REFRESH_SINGLETON_KEYS[\s\S]*'manual-incremental'/.test(reaper) &&
  /THEN \$\{ORDER_REFRESH_SINGLETON_KEY\}/.test(reaper));
check('stale cadence reaper uses the stale-queued allow-list',
  /REAPER_STALE_QUEUED_JOB_NAMES/.test(reaper) &&
  /name = ANY\(\$\{REAPER_STALE_QUEUED_JOB_NAMES as string\[\]\}\)/.test(reaper));
check('stale cadence reaper fails pgboss rows rather than deleting data',
  /SET state = 'failed'/.test(reaper) && !/DELETE FROM/.test(reaper));
check('queue recovery SQL has a dedicated one-connection control-plane client',
  /reaperTransactionPoolerCompatibility = \{ max_pipeline: 1 \}/.test(reaper) &&
  /const reaperSql = postgres\(env\.DATABASE_URL,[\s\S]*max: 1,[\s\S]*reaperTransactionPoolerCompatibility/.test(reaper) &&
  !/from ['"]\.\.\/db\/client/.test(reaper));
check('stale queued reaper records PS-360/PS-361 reason',
  /PS-360\/PS-361 stale queued sync reaper/.test(reaper));
check('fulfillment and fee side-effect jobs remain excluded from the active safe allow-list',
  !/prepship\.sync\.fulfillment-outbox'/.test(
    reaper.match(/REAPER_SAFE_JOB_NAMES[\s\S]*?\];/)?.[0] ?? ''
  ) &&
  !/prepship\.fees\.walmart-sync'/.test(
    reaper.match(/REAPER_SAFE_JOB_NAMES[\s\S]*?\];/)?.[0] ?? ''
  ));
check('bounded external-shipped classifier active rows are explicitly reapable',
  /REAPER_SAFE_JOB_NAMES[\s\S]*prepship\.shipping\.external-shipped-classifier/.test(reaper) &&
  /bounded external-shipped[\s\S]*idempotent flag reconciliation/.test(reaper));
check('stale queued fulfillment-outbox cadence rows are explicitly collapsible',
  /REAPER_STALE_QUEUED_JOB_NAMES[\s\S]*prepship\.sync\.fulfillment-outbox/.test(reaper) &&
  /queued fulfillment-outbox[\s\S]*wake-up ticks/.test(reaper) &&
  /ACTIVE fulfillment jobs remain excluded/.test(reaper));
check('worker runs stale cadence reaper on boot',
  /const queuedReap = await reapStaleQueuedCadenceJobs\(\)/.test(queue));
check('worker runs stale cadence reaper through durable 10-minute pg-boss maintenance',
  /registerWorker\(JOBS\.queueMaintenance,[\s\S]*reapStaleQueuedCadenceJobs\(\)/.test(queue) &&
  /JOBS\.queueMaintenance,[\s\S]*SCHEDULE_CRON\.everyTenMinutes/.test(queue));
check(
  'package.json wires test:ps-360-stale-cadence-reaper',
  /"test:ps-360-stale-cadence-reaper"\s*:\s*"tsx scripts\/ps-360-stale-cadence-reaper-guard\.ts"/.test(pkg),
);

if (failures > 0) {
  console.error(`\nFAIL PS-360 stale cadence reaper guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-360 stale cadence reaper guard');
