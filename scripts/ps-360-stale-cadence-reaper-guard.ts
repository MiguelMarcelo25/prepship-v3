/**
 * PS-360 stale cadence reaper guard.
 *
 * Cadence/busy-defer sync jobs are watermark-based. If the worker is down or
 * wedged, old `created` sync ticks become redundant backlog and can starve
 * current shipment work. The queue owner may fail old redundant queued rows,
 * but only for the safe sync allow-list and never for side-effect queues.
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
  /PARTITION BY name, singleton_key/.test(reaper));
check('stale cadence reaper only considers created/retry rows',
  /state IN \('created', 'retry'\)/.test(reaper));
check('stale queued reaper only considers safe sync singleton rows',
  /REAPER_STALE_QUEUED_SINGLETON_KEYS/.test(reaper) &&
  /'cadence'/.test(reaper) &&
  /'busy-defer'/.test(reaper) &&
  /'watchdog-recovery'/.test(reaper) &&
  /singleton_key = ANY\(\$\{REAPER_STALE_QUEUED_SINGLETON_KEYS as string\[\]\}\)/.test(reaper));
check('stale cadence reaper uses the same safe allow-list',
  /name = ANY\(\$\{REAPER_SAFE_JOB_NAMES as string\[\]\}\)/.test(reaper));
check('stale cadence reaper fails pgboss rows rather than deleting data',
  /SET state = 'failed'/.test(reaper) && !/DELETE FROM/.test(reaper));
check('stale queued reaper records PS-360/PS-361 reason',
  /PS-360\/PS-361 stale queued sync reaper/.test(reaper));
check('side-effect jobs remain excluded from the shared safe allow-list',
  !/prepship\.sync\.fulfillment-outbox'/.test(
    reaper.match(/REAPER_SAFE_JOB_NAMES[\s\S]*?\];/)?.[0] ?? ''
  ) &&
  !/prepship\.shipping\.external-shipped-classifier'/.test(
    reaper.match(/REAPER_SAFE_JOB_NAMES[\s\S]*?\];/)?.[0] ?? ''
  ) &&
  !/prepship\.fees\.walmart-sync'/.test(
    reaper.match(/REAPER_SAFE_JOB_NAMES[\s\S]*?\];/)?.[0] ?? ''
  ));
check('worker runs stale cadence reaper on boot',
  /reapStaleQueuedCadenceJobs\(\)\.then/.test(queue));
check('worker runs stale cadence reaper every 10 minutes',
  /setInterval\(\(\) => void reapStaleQueuedCadenceJobs\(\), 10 \* 60_000\)/.test(queue));
check(
  'package.json wires test:ps-360-stale-cadence-reaper',
  /"test:ps-360-stale-cadence-reaper"\s*:\s*"tsx scripts\/ps-360-stale-cadence-reaper-guard\.ts"/.test(pkg),
);

if (failures > 0) {
  console.error(`\nFAIL PS-360 stale cadence reaper guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-360 stale cadence reaper guard');
