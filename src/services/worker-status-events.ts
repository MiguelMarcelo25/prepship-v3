// PS-256 (durable runtime state) — DURABLE WORKER-STATUS EVENTS.
//
// worker-status.ts keeps an in-memory snapshot + a single overwritten settings row, so a
// restart erases all history of worker liveness. Operators can't answer "was the worker
// stuck 14:32-15:17?". This is a durable, APPEND-ONLY event log of heartbeats, job
// start/complete/failed transitions, and staleness alerts.
//
// ENV-GATED, default OFF (WORKER_STATUS_EVENTS_DURABLE). The OFF path is a TRUE no-op:
// no DB call, no schema ensure, zero cost — so merging this changes nothing until DJ
// flips it on + watches a canary on Render.
//
// Best-effort: emit NEVER throws into the worker heartbeat/job hot path (mirrors the
// existing best-effort persistSnapshot). Migration 0062 owns the additive event table;
// boot readiness blocks work when the table is absent.
import { sql as pg } from '../db/client.js';
import { env } from '../lib/env.js';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

export type WorkerStatusEventType =
  | 'heartbeat'
  | 'job_start'
  | 'job_complete'
  | 'job_failed'
  | 'staleness_alert';

export type WorkerStatusEvent = {
  service: string;
  pid: number;
  eventType: WorkerStatusEventType;
  jobName?: string | null;
  stalenessLevel?: string | null;
  details?: unknown;
};

export type WorkerStatusEventRow = {
  id: string;
  createdAt: string;
  workerService: string | null;
  workerPid: number | null;
  eventType: string;
  jobName: string | null;
  stalenessLevel: string | null;
  details: unknown;
};

/** True only when DJ has flipped the canary on Render. Default OFF. */
export function workerStatusEventsEnabled(): boolean {
  return env.WORKER_STATUS_EVENTS_DURABLE;
}

/** Migration readiness for durable worker events. */
export async function ensureWorkerStatusEventsSchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}

/**
 * Append one worker-status event. NO-OP when the flag is OFF (no DB, no schema ensure).
 * Best-effort: never throws into the caller's hot path — a failed insert is logged at most.
 */
export async function recordWorkerStatusEvent(evt: WorkerStatusEvent): Promise<void> {
  if (!workerStatusEventsEnabled()) return;
  try {
    await ensureWorkerStatusEventsSchema();
    const details =
      evt.details === undefined || evt.details === null ? null : JSON.stringify(evt.details);
    await pg`
      INSERT INTO worker_status_events
        (worker_service, worker_pid, event_type, job_name, staleness_level, details)
      VALUES (
        ${evt.service},
        ${evt.pid},
        ${evt.eventType},
        ${evt.jobName ?? null},
        ${evt.stalenessLevel ?? null},
        ${details}::jsonb
      )
    `;
  } catch (err) {
    console.warn(
      '[worker-status-events] failed to append event:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * PS-431: how long durable worker events are kept.
 *
 * This log is append-only and its emission rate is fixed by the heartbeat, not by
 * traffic: one row every 30s per worker plus job start/complete/failed, so roughly
 * 3,000-5,000 rows/day forever. Without a bound that is the same shape that took
 * automation_runs to 925 MB in a week (PS-469) -- the difference being that this table
 * would grow at a constant rate whether or not anything is happening.
 *
 * 30 days is chosen against the actual use: this exists to answer "was the worker stuck
 * 14:32-15:17" during an incident review. The 2026-07-13 crash loop could not be
 * root-caused on 2026-08-01 because Render logs had aged out at 19 days, so a window
 * shorter than that would inherit the same failure. A month covers the realistic gap
 * between an incident and someone investigating it.
 */
export const WORKER_STATUS_EVENT_RETENTION_DAYS = 30;

/**
 * Delete worker events older than the retention window.
 *
 * NO-OP when the flag is OFF, matching emit: if nothing is being written there is
 * nothing to prune, and the OFF path must stay a true no-op with no DB call.
 *
 * Best-effort by the same rule as recordWorkerStatusEvent -- this runs from the
 * watchdog tick, and a failed cleanup must never take down the caller. Returns the
 * number of rows deleted so the caller can log a real figure rather than assume.
 */
export async function pruneWorkerStatusEvents(
  retentionDays: number = WORKER_STATUS_EVENT_RETENTION_DAYS,
  // Seam so the retention rule is testable without a database. Defaults to the real
  // client; a test passes a recording tag and asserts the statement and cutoff.
  conn: typeof pg = pg,
): Promise<number> {
  if (!workerStatusEventsEnabled()) return 0;
  if (!(retentionDays > 0)) return 0;
  try {
    if (conn === pg) await ensureWorkerStatusEventsSchema();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    // Deletes ONLY from worker_status_events, which holds process-liveness telemetry.
    // No order, shipment, label, or billing row is reachable from this statement.
    const deleted = await conn`
      DELETE FROM worker_status_events WHERE created_at < ${cutoff}
    `;
    return deleted.count ?? 0;
  } catch (err) {
    console.warn(
      '[worker-status-events] failed to prune old events:',
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

/**
 * PS-431: how often the prune is allowed to actually run.
 *
 * The watchdog tick is the only caller and fires every ~5 minutes. A DELETE scan at that
 * cadence is pure waste when the window is 30 days -- nothing meaningful ages out between
 * two ticks. Six hours keeps the table bounded while making the delete rare.
 */
const PRUNE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastPruneAtMs = 0;

/**
 * Throttled prune for periodic callers. Safe to call on every watchdog tick.
 *
 * Kept separate from pruneWorkerStatusEvents so the retention rule stays directly
 * testable without waiting on a clock. Returns null when the call was skipped, so a
 * caller can tell "nothing was due" apart from "ran and deleted nothing".
 */
export async function pruneWorkerStatusEventsIfDue(
  conn: typeof pg = pg,
): Promise<number | null> {
  if (!workerStatusEventsEnabled()) return null;
  const now = Date.now();
  if (lastPruneAtMs !== 0 && now - lastPruneAtMs < PRUNE_MIN_INTERVAL_MS) return null;
  lastPruneAtMs = now;
  return pruneWorkerStatusEvents(WORKER_STATUS_EVENT_RETENTION_DAYS, conn);
}

/** Test seam: reset the throttle so a suite can drive the due/not-due branches. */
export function __resetWorkerStatusEventPruneThrottle(): void {
  lastPruneAtMs = 0;
}

/**
 * Read recent worker-status events (newest first). Returns [] when the flag is OFF.
 * limit defaults to 50, capped at 1000; optional event_type filter.
 */
export async function readWorkerStatusEvents(
  opts: { limit?: number; eventType?: string } = {},
): Promise<WorkerStatusEventRow[]> {
  if (!workerStatusEventsEnabled()) return [];
  const limit = Math.min(1000, Math.max(1, Math.trunc(opts.limit ?? 50)));
  await ensureWorkerStatusEventsSchema();
  const rows = opts.eventType
    ? await pg<WorkerStatusEventRow[]>`
        SELECT id::text AS id, created_at AS "createdAt", worker_service AS "workerService",
               worker_pid AS "workerPid", event_type AS "eventType", job_name AS "jobName",
               staleness_level AS "stalenessLevel", details
        FROM worker_status_events
        WHERE event_type = ${opts.eventType}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
    : await pg<WorkerStatusEventRow[]>`
        SELECT id::text AS id, created_at AS "createdAt", worker_service AS "workerService",
               worker_pid AS "workerPid", event_type AS "eventType", job_name AS "jobName",
               staleness_level AS "stalenessLevel", details
        FROM worker_status_events
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
  return rows;
}
