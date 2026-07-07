import { sql as pg } from '../../db/client.js';
import type { QueueSendJobSnapshot } from './queue-send-snapshot';
import type {
  QueueSendJobItemInput,
  QueueSendJobItemRecord,
  QueueSendJobItemState,
} from './queue-send-item-state';

export type {
  QueueSendJobItemInput,
  QueueSendJobItemRecord,
  QueueSendJobItemState,
} from './queue-send-item-state';

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
    await pg`
      CREATE TABLE IF NOT EXISTS print_queue_batch_job_items (
        id bigserial PRIMARY KEY,
        job_id text NOT NULL,
        order_id integer NOT NULL,
        client_id integer,
        state text NOT NULL,
        blocked_reason text,
        error_message text,
        queue_entry_id text,
        tracking_number text,
        result jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (job_id, order_id)
      )
    `;
    await pg`
      CREATE INDEX IF NOT EXISTS print_queue_batch_job_items_job_idx
        ON print_queue_batch_job_items (job_id, updated_at DESC)
    `;
    await pg`
      CREATE INDEX IF NOT EXISTS print_queue_batch_job_items_state_idx
        ON print_queue_batch_job_items (state)
    `;
    await pg`ALTER TABLE print_queue_send_jobs ENABLE ROW LEVEL SECURITY`;
    await pg`ALTER TABLE print_queue_batch_job_items ENABLE ROW LEVEL SECURITY`;
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
    WHERE print_queue_send_jobs.updated_at <= ${snapshot.updatedAt}
  `;
}

export async function persistQueueSendJobItems(
  jobId: string,
  items: QueueSendJobItemInput[],
): Promise<void> {
  if (!jobId || items.length === 0) return;
  await ensureQueueSendJobStoreSchema();
  for (const item of items) {
    const resultJson = item.result ? JSON.stringify(item.result) : null;
    await pg`
      INSERT INTO print_queue_batch_job_items (
        job_id,
        order_id,
        client_id,
        state,
        blocked_reason,
        error_message,
        queue_entry_id,
        tracking_number,
        result,
        updated_at
      )
      VALUES (
        ${jobId},
        ${item.orderId},
        ${item.clientId ?? null},
        ${item.state},
        ${item.blockedReason ?? null},
        ${item.errorMessage ?? null},
        ${item.queueEntryId ?? null},
        ${item.trackingNumber ?? null},
        ${resultJson}::jsonb,
        now()
      )
      ON CONFLICT (job_id, order_id) DO UPDATE SET
        client_id = ${item.clientId ?? null},
        state = ${item.state},
        blocked_reason = ${item.blockedReason ?? null},
        error_message = ${item.errorMessage ?? null},
        queue_entry_id = ${item.queueEntryId ?? null},
        tracking_number = ${item.trackingNumber ?? null},
        result = ${resultJson}::jsonb,
        updated_at = now()
    `;
  }
}

export async function updateQueueSendJobItemState(
  jobId: string,
  orderId: number,
  patch: Omit<QueueSendJobItemInput, 'orderId'>,
): Promise<void> {
  await persistQueueSendJobItems(jobId, [{ ...patch, orderId }]);
}

export async function getQueueSendJobItemRecords(jobId: string): Promise<QueueSendJobItemRecord[]> {
  if (!jobId) return [];
  try {
    await ensureQueueSendJobStoreSchema();
    const rows = await pg<Array<{
      job_id: string;
      order_id: number;
      client_id: number | null;
      state: QueueSendJobItemState;
      blocked_reason: string | null;
      error_message: string | null;
      queue_entry_id: string | null;
      tracking_number: string | null;
      result: Record<string, unknown> | null;
      created_at: Date | string | null;
      updated_at: Date | string | null;
    }>>`
      SELECT
        job_id,
        order_id,
        client_id,
        state,
        blocked_reason,
        error_message,
        queue_entry_id,
        tracking_number,
        result,
        created_at,
        updated_at
      FROM print_queue_batch_job_items
      WHERE job_id = ${jobId}
      ORDER BY updated_at ASC, order_id ASC
    `;
    return rows.map((row) => ({
      jobId: row.job_id,
      orderId: Number(row.order_id),
      clientId: row.client_id,
      state: row.state,
      blockedReason: row.blocked_reason,
      errorMessage: row.error_message,
      queueEntryId: row.queue_entry_id,
      trackingNumber: row.tracking_number,
      result: row.result,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    }));
  } catch (err) {
    console.warn(
      '[print-queue-job-store] failed to read queue-send item states:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
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

export async function getRecoverableQueueSendJobRecords(options: {
  staleAfterMs: number;
  limit?: number;
}): Promise<QueueSendJobSnapshot[]> {
  const staleAfterSeconds = Math.max(1, Math.ceil(options.staleAfterMs / 1000));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  try {
    await ensureQueueSendJobStoreSchema();
    const rows = await pg<{ snapshot: unknown }[]>`
      SELECT snapshot
      FROM print_queue_send_jobs
      WHERE status IN ('pending', 'running')
        AND updated_at < now() - (${staleAfterSeconds} * interval '1 second')
      ORDER BY updated_at ASC
      LIMIT ${limit}
    `;
    return rows
      .map((row) => parseQueueSendJobSnapshot(row.snapshot))
      .filter((snapshot): snapshot is QueueSendJobSnapshot => Boolean(snapshot));
  } catch (err) {
    console.warn(
      '[print-queue-job-store] failed to read recoverable queue-send jobs:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
