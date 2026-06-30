import { sql as pg } from '../../db/client.js';
import type { QueueSendJobSnapshot } from './queue-send-snapshot';

let schemaEnsured: Promise<void> | null = null;

function parseQueueSendJobSnapshot(value: unknown): QueueSendJobSnapshot | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as QueueSendJobSnapshot;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') {
    return value as QueueSendJobSnapshot;
  }
  return null;
}

/**
 * Runtime DDL follows the existing additive durable-state pattern. The table is
 * not in the Drizzle schema index, so first deploys do not 500 before the
 * additive table exists.
 */
export async function ensureQueueSendJobStoreSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS print_queue_send_jobs (
        job_id text PRIMARY KEY,
        job_type text NOT NULL DEFAULT 'batch_send',
        status text NOT NULL,
        active boolean NOT NULL DEFAULT false,
        client_id integer,
        client_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        progress integer NOT NULL DEFAULT 0,
        total integer NOT NULL DEFAULT 0,
        current integer NOT NULL DEFAULT 0,
        queued integer NOT NULL DEFAULT 0,
        failed integer NOT NULL DEFAULT 0,
        message text,
        snapshot jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await pg`
      CREATE INDEX IF NOT EXISTS print_queue_send_jobs_updated_at_idx
        ON print_queue_send_jobs (updated_at DESC)
    `;
    await pg`ALTER TABLE print_queue_send_jobs ENABLE ROW LEVEL SECURITY`;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

export async function persistQueueSendJobRecord(snapshot: QueueSendJobSnapshot): Promise<void> {
  await ensureQueueSendJobStoreSchema();
  const clientIdsJson = JSON.stringify(snapshot.clientIds ?? []);
  const snapshotJson = JSON.stringify(snapshot);
  await pg`
    INSERT INTO print_queue_send_jobs (
      job_id,
      job_type,
      status,
      active,
      client_id,
      client_ids,
      progress,
      total,
      current,
      queued,
      failed,
      message,
      snapshot,
      created_at,
      updated_at
    )
    VALUES (
      ${snapshot.jobId},
      'batch_send',
      ${snapshot.status},
      ${snapshot.active},
      ${snapshot.clientId},
      ${clientIdsJson}::jsonb,
      ${snapshot.progress},
      ${snapshot.total},
      ${snapshot.current},
      ${snapshot.queued},
      ${snapshot.failed},
      ${snapshot.message},
      ${snapshotJson}::jsonb,
      ${snapshot.createdAt},
      ${snapshot.updatedAt}
    )
    ON CONFLICT (job_id) DO UPDATE SET
      status = ${snapshot.status},
      active = ${snapshot.active},
      client_id = ${snapshot.clientId},
      client_ids = ${clientIdsJson}::jsonb,
      progress = ${snapshot.progress},
      total = ${snapshot.total},
      current = ${snapshot.current},
      queued = ${snapshot.queued},
      failed = ${snapshot.failed},
      message = ${snapshot.message},
      snapshot = ${snapshotJson}::jsonb,
      updated_at = ${snapshot.updatedAt}
  `;
}

export async function getQueueSendJobRecord(jobId: string): Promise<QueueSendJobSnapshot | null> {
  if (!jobId) return null;
  try {
    await ensureQueueSendJobStoreSchema();
    const rows = await pg<{ snapshot: unknown }[]>`
      SELECT snapshot
      FROM print_queue_send_jobs
      WHERE job_id = ${jobId}
      LIMIT 1
    `;
    return parseQueueSendJobSnapshot(rows[0]?.snapshot);
  } catch (err) {
    console.warn(
      '[print-queue-job-store] failed to read queue-send job:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function getLatestQueueSendJobRecord(): Promise<QueueSendJobSnapshot | null> {
  try {
    await ensureQueueSendJobStoreSchema();
    const rows = await pg<{ snapshot: unknown }[]>`
      SELECT snapshot
      FROM print_queue_send_jobs
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return parseQueueSendJobSnapshot(rows[0]?.snapshot);
  } catch (err) {
    console.warn(
      '[print-queue-job-store] failed to read latest queue-send job:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
