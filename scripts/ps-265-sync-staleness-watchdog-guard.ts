/**
 * PS-265 (secondary) guard — active sync-staleness watchdog.
 *
 * PS-265 core bounded job handlers with withDeadline so a stuck sync self-heals; this slice
 * makes a stuck/stale worker NOTICED. worker-status only computes `stale` passively when
 * read; the watchdog runs on an independent timer, reads the persisted snapshot, and emits
 * one structured `[sync-watchdog]` alert when the heartbeat is stale or a job is held past
 * its deadline. This unit-tests the pure decision + pins the scheduler wiring.
 *
 *   npx tsx scripts/ps-265-sync-staleness-watchdog-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  evaluateSyncStaleness,
  SYNC_HEARTBEAT_STALE_SECONDS,
  SYNC_JOB_STUCK_SECONDS,
} from '../src/services/sync-staleness-watchdog';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── ok: fresh heartbeat, no long-held job ────────────────────────────────────
const ok = evaluateSyncStaleness({ heartbeatAgeSeconds: 30, currentJob: null, currentJobAgeSeconds: null });
check('fresh heartbeat + no job -> ok, no alert', ok.level === 'ok' && ok.alert === false);
const okJob = evaluateSyncStaleness({ heartbeatAgeSeconds: 30, currentJob: 'orders', currentJobAgeSeconds: 60 });
check('short-running job (60s) -> ok, no alert', okJob.level === 'ok' && okJob.alert === false);

// ── stale: heartbeat past threshold, or missing ──────────────────────────────
const stale = evaluateSyncStaleness({ heartbeatAgeSeconds: 400, currentJob: null, currentJobAgeSeconds: null });
check('heartbeat 400s (> 300) -> stale + alert', stale.level === 'stale' && stale.alert === true);
const noSnap = evaluateSyncStaleness({ heartbeatAgeSeconds: null, currentJob: null, currentJobAgeSeconds: null });
check('no snapshot (null heartbeat) -> stale + alert', noSnap.level === 'stale' && noSnap.alert === true);

// ── stuck: a job held past the deadline outranks a stale heartbeat ────────────
const stuck = evaluateSyncStaleness({ heartbeatAgeSeconds: 30, currentJob: 'walmart-fees', currentJobAgeSeconds: 1000 });
check('job held 1000s (> 900) -> stuck + alert', stuck.level === 'stuck' && stuck.alert === true);
const stuckOutranksStale = evaluateSyncStaleness({ heartbeatAgeSeconds: 400, currentJob: 'walmart-fees', currentJobAgeSeconds: 1000 });
check('stuck outranks stale when both fire', stuckOutranksStale.level === 'stuck');

// ── boundaries: strictly greater-than, defaults wired ────────────────────────
check('heartbeat exactly at threshold is NOT stale',
  evaluateSyncStaleness({ heartbeatAgeSeconds: SYNC_HEARTBEAT_STALE_SECONDS, currentJob: null, currentJobAgeSeconds: null }).level === 'ok');
check('heartbeat one second over threshold IS stale',
  evaluateSyncStaleness({ heartbeatAgeSeconds: SYNC_HEARTBEAT_STALE_SECONDS + 1, currentJob: null, currentJobAgeSeconds: null }).level === 'stale');
check('job exactly at stuck threshold is NOT stuck',
  evaluateSyncStaleness({ heartbeatAgeSeconds: 30, currentJob: 'x', currentJobAgeSeconds: SYNC_JOB_STUCK_SECONDS }).level === 'ok');
check('thresholds are sane (stuck > stale, both positive)',
  SYNC_JOB_STUCK_SECONDS > SYNC_HEARTBEAT_STALE_SECONDS && SYNC_HEARTBEAT_STALE_SECONDS > 0);

// ── wiring: scheduler starts the watchdog; watchdog reads persisted status + alerts ──
const scheduler = read('src/services/sync-scheduler.ts');
check('scheduler imports startSyncStalenessWatchdog', scheduler.includes("from './sync-staleness-watchdog'"));
check('scheduler starts the watchdog in startSyncScheduler', /startSyncStalenessWatchdog\(\)/.test(scheduler));

const watchdog = read('src/services/sync-staleness-watchdog.ts');
check('watchdog reads the persisted worker snapshot', watchdog.includes('getPersistedWorkerStatus'));
check('watchdog emits a structured [sync-watchdog] alert', watchdog.includes('[sync-watchdog]'));
check('watchdog timer is unref-ed (never keeps the process alive)', /\.unref\(\)/.test(watchdog));

const pkg = read('package.json');
check('package.json wires test:ps-265-sync-staleness-watchdog', /test:ps-265-sync-staleness-watchdog/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-265 sync-staleness watchdog guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-265 sync-staleness watchdog guard');
