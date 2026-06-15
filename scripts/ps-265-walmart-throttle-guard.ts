/**
 * PS-265 (slice 2) guard — a cadence job's singleton window can't exceed pg-boss's
 * archive interval, so the daily walmart-fees job can actually enqueue.
 *
 * The old formula gave the DAILY job (86400s) a singletonSeconds of 86395 — above
 * pg-boss's 12h (43200s) archive interval — so pg-boss rejected every enqueue
 * ("throttling interval cannot exceed archive interval") and the walmart-fees job
 * never ran. jobSingletonSeconds now caps the window safely below the archive
 * interval; sub-cap jobs are unchanged.
 *
 *   npx tsx scripts/ps-265-walmart-throttle-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  jobSingletonSeconds,
  MAX_SINGLETON_SECONDS,
  PGBOSS_ARCHIVE_SECONDS,
} from '../src/lib/job-singleton-seconds';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

const DAY_MS = 24 * 60 * 60 * 1000;

// The fix: the daily walmart-fees job's window is now under the archive interval.
check('daily job singleton < pg-boss archive interval (can enqueue)',
  jobSingletonSeconds(DAY_MS) < PGBOSS_ARCHIVE_SECONDS);
check('daily job singleton is clamped to the cap', jobSingletonSeconds(DAY_MS) === MAX_SINGLETON_SECONDS);
check('the cap itself is below the archive interval', MAX_SINGLETON_SECONDS < PGBOSS_ARCHIVE_SECONDS);

// Sub-cap cadences are unchanged (no behavior change for the frequent jobs).
check('3-min job unchanged (175s)', jobSingletonSeconds(180_000) === 175);
check('hourly job unchanged (3595s)', jobSingletonSeconds(3_600_000) === 3595);
check('floor is 30s', jobSingletonSeconds(1000) === 30);

// Wired through the queue, not redefined locally.
const q = read('src/services/sync-job-queue.ts');
check('sync-job-queue imports jobSingletonSeconds from the module',
  /import \{ jobSingletonSeconds \} from '\.\.\/lib\/job-singleton-seconds'/.test(q));
check('sync-job-queue no longer redefines jobSingletonSeconds',
  !/function jobSingletonSeconds\(/.test(q));

const pkg = read('package.json');
check('package.json wires test:ps-265-walmart-throttle', /test:ps-265-walmart-throttle/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-265 walmart-throttle guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-265 walmart-throttle guard');
