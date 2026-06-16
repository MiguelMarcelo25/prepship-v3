// PS-265 (secondary slice): active sync-staleness watchdog.
//
// PS-265 core bounded each job handler with withDeadline so a stuck sync can SELF-HEAL.
// This is the other half — make a stuck/stale worker NOTICED without a manual Render
// restart. worker-status.ts only computes `stale` PASSIVELY (when something reads the
// snapshot, e.g. a health endpoint). This watchdog runs on an INDEPENDENT timer, reads
// the persisted snapshot, and emits ONE structured `[sync-watchdog]` alert when the
// heartbeat is stale or a job has been held past its deadline — so a wedged sync surfaces
// in logs / alerting on its own.
//
// It reads the PERSISTED snapshot (written by whichever process owns the scheduler), so it
// works cross-process, and its timer is independent of the job queue, so a stuck async JOB
// handler (the PS-265 deadlock class — awaiting a hung provider) cannot also silence the
// watchdog. (A fully blocked event loop would still stop the timer, but the bounded async
// handler does not block the loop — it is awaiting.)

import { getPersistedWorkerStatus } from './worker-status';
import { recordWorkerStatusEvent } from './worker-status-events';

export type SyncStalenessLevel = 'ok' | 'stale' | 'stuck';

export type SyncStalenessVerdict = {
  level: SyncStalenessLevel;
  alert: boolean;
  reason: string;
  heartbeatAgeSeconds: number | null;
  currentJob: string | null;
  currentJobAgeSeconds: number | null;
};

// Heartbeat older than this => the scheduler process is not ticking (heartbeat fires ~30s).
export const SYNC_HEARTBEAT_STALE_SECONDS = 300; // 5 min
// A job held "running" past this => its withDeadline bound (PS-265 core, ~10 min) failed to
// fire, i.e. genuinely wedged — alert so it can be investigated.
export const SYNC_JOB_STUCK_SECONDS = 15 * 60; // 15 min (> the 10-min handler deadline + buffer)
export const SYNC_WATCHDOG_INTERVAL_MS = 60_000;

/** Pure staleness decision. A job held past its deadline ('stuck') outranks a stale
 *  heartbeat ('stale'); neither => 'ok'. No I/O — unit-testable. */
export function evaluateSyncStaleness(input: {
  heartbeatAgeSeconds: number | null;
  currentJob: string | null;
  currentJobAgeSeconds: number | null;
  staleThresholdSeconds?: number;
  stuckThresholdSeconds?: number;
}): SyncStalenessVerdict {
  const staleThreshold = input.staleThresholdSeconds ?? SYNC_HEARTBEAT_STALE_SECONDS;
  const stuckThreshold = input.stuckThresholdSeconds ?? SYNC_JOB_STUCK_SECONDS;
  const base = {
    heartbeatAgeSeconds: input.heartbeatAgeSeconds,
    currentJob: input.currentJob,
    currentJobAgeSeconds: input.currentJobAgeSeconds,
  };

  if (
    input.currentJob != null &&
    input.currentJobAgeSeconds != null &&
    input.currentJobAgeSeconds > stuckThreshold
  ) {
    return {
      ...base,
      level: 'stuck',
      alert: true,
      reason: `job "${input.currentJob}" held ${input.currentJobAgeSeconds}s (> ${stuckThreshold}s) — handler deadline failed to free it`,
    };
  }

  if (input.heartbeatAgeSeconds === null || input.heartbeatAgeSeconds > staleThreshold) {
    return {
      ...base,
      level: 'stale',
      alert: true,
      reason:
        input.heartbeatAgeSeconds === null
          ? 'no worker heartbeat snapshot found — scheduler may never have started'
          : `heartbeat ${input.heartbeatAgeSeconds}s old (> ${staleThreshold}s) — scheduler not ticking`,
    };
  }

  return { ...base, level: 'ok', alert: false, reason: 'heartbeat fresh; no job held past deadline' };
}

function jobAgeSeconds(startedAt: string | null | undefined, nowMs: number): number | null {
  if (!startedAt) return null;
  const ms = Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(0, Math.round((nowMs - ms) / 1000)) : null;
}

/** Read the persisted snapshot, evaluate staleness, and emit ONE structured alert when
 *  not ok. Returns the verdict (also used by the guard / a future health endpoint). */
export async function runSyncStalenessWatchdogTick(nowMs: number = Date.now()): Promise<SyncStalenessVerdict> {
  const { status, heartbeatAgeSeconds } = await getPersistedWorkerStatus();
  const currentJob = status?.currentJob ?? null;
  const currentJobAgeSeconds =
    currentJob && status ? jobAgeSeconds(status.jobs[currentJob]?.startedAt, nowMs) : null;

  const verdict = evaluateSyncStaleness({ heartbeatAgeSeconds, currentJob, currentJobAgeSeconds });
  if (verdict.alert) {
    console.error(
      `[sync-watchdog] ${verdict.level.toUpperCase()}: ${verdict.reason} ` +
        `(heartbeatAge=${verdict.heartbeatAgeSeconds ?? 'none'}s job=${verdict.currentJob ?? 'none'} ` +
        `jobAge=${verdict.currentJobAgeSeconds ?? 'none'}s)`,
    );
    // PS-256: persist a durable staleness alert so the wedge survives a restart in the
    // operator-visible history. Best-effort, no-op when WORKER_STATUS_EVENTS_DURABLE off.
    void recordWorkerStatusEvent({
      service: status?.service ?? 'worker',
      pid: status?.pid ?? process.pid,
      eventType: 'staleness_alert',
      jobName: verdict.currentJob,
      stalenessLevel: verdict.level,
      details: {
        reason: verdict.reason,
        heartbeatAgeSeconds: verdict.heartbeatAgeSeconds,
        currentJobAgeSeconds: verdict.currentJobAgeSeconds,
      },
    });
  }
  return verdict;
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** Start the independent watchdog timer (idempotent). Returns a stop fn. */
export function startSyncStalenessWatchdog(intervalMs: number = SYNC_WATCHDOG_INTERVAL_MS): () => void {
  if (!watchdogTimer) {
    watchdogTimer = setInterval(() => void runSyncStalenessWatchdogTick(), intervalMs);
    // Never keep the process alive just for the watchdog.
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
  }
  return () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };
}
