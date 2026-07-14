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
