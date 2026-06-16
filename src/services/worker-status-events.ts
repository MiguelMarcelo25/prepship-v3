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
// existing best-effort persistSnapshot). Additive-table 500-safe pattern (like
// ensureRateLimiterSchema): runtime CREATE TABLE IF NOT EXISTS, NOT in the drizzle
// schema index (a bare drizzle select() over the index would otherwise emit the new
// columns and 500 prod before the table exists).
import { sql as pg } from '../db/client.js';
import { env } from '../lib/env.js';

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

let schemaEnsured: Promise<void> | null = null;

/** Memoized runtime DDL (mirrors ensureRateLimiterSchema). Additive, 500-safe. */
export async function ensureWorkerStatusEventsSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS worker_status_events (
        id bigserial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        worker_service text,
        worker_pid int,
        event_type text NOT NULL,
        job_name text,
        staleness_level text,
        details jsonb
      )
    `;
    await pg`
      CREATE INDEX IF NOT EXISTS worker_status_events_created_at_idx
        ON worker_status_events (created_at DESC)
    `;
    await pg`ALTER TABLE worker_status_events ENABLE ROW LEVEL SECURITY`;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
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
