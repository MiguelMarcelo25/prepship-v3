import { sql as pg } from '../../db/client.js';
import { assertRuntimeSchemaReady } from '../runtime-schema-readiness.js';
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

// Per user override unlock shipped data on 2026-07-21: PS-452 metadata lives
// only in Print Queue job/item sidecars and never mutates orders or shipments.
function normalizeNonNegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function withExecutionMetadata(
  value: unknown,
  generation: unknown,
  chunkSequence: unknown,
  durableUpdatedAt?: unknown,
): QueueSendJobSnapshot | null {
  const snapshot = parseQueueSendJobSnapshot(value);
  if (!snapshot) return null;
  const updatedAt = durableUpdatedAt instanceof Date
    ? durableUpdatedAt.toISOString()
    : typeof durableUpdatedAt === 'string'
      ? durableUpdatedAt
      : snapshot.updatedAt;
  return {
    ...snapshot,
    generation: normalizeNonNegativeInteger(generation),
    chunkSequence: Math.max(1, normalizeNonNegativeInteger(chunkSequence)),
    recoveryAttempts: normalizeNonNegativeInteger(generation),
    updatedAt,
    persistedAt: updatedAt,
  };
}

/** Migration readiness for durable queue-send state. */
export async function ensureQueueSendJobStoreSchema(): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: migration 0062 owns
  // queue-send sidecars; job state semantics remain unchanged.
  await assertRuntimeSchemaReady();
}

export async function persistQueueSendJobRecord(snapshot: QueueSendJobSnapshot): Promise<boolean> {
  await ensureQueueSendJobStoreSchema();
  const clientIdsJson = JSON.stringify(snapshot.clientIds ?? []);
  const snapshotJson = JSON.stringify(snapshot);
  const rows = await pg<Array<{ jobId: string }>>`
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
      generation,
      current_chunk_sequence,
      snapshot_updated_at,
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
      ${snapshot.generation},
      ${snapshot.chunkSequence},
      ${snapshot.persistedAt},
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
      snapshot_updated_at = ${snapshot.persistedAt},
      updated_at = ${snapshot.updatedAt}
    WHERE print_queue_send_jobs.generation = ${snapshot.generation}
      AND coalesce(print_queue_send_jobs.snapshot_updated_at, print_queue_send_jobs.updated_at)
        <= ${snapshot.persistedAt}
    RETURNING job_id AS "jobId"
  `;
  return rows.length === 1;
}

// Audit PQ-7 (2026-07-13): COUNTERS-ONLY progress update. The per-order progress
// persist used to rewrite the whole snapshot jsonb (workerOrders + every result —
// hundreds of KB, O(n^2) WAL churn across a big batch); progress needs only the
// scalar columns. Same monotonic updated_at guard as the full upsert. A missing
// row is a no-op (the start/terminal paths write the full record).
export async function persistQueueSendJobCounters(snapshot: {
  jobId: string;
  generation: number;
  status: string;
  active: boolean;
  progress: number;
  total: number;
  current: number;
  queued: number;
  failed: number;
  message: string | null;
  updatedAt: string;
}): Promise<boolean> {
  if (!snapshot.jobId) return false;
  await ensureQueueSendJobStoreSchema();
  const rows = await pg<Array<{ jobId: string }>>`
    UPDATE print_queue_send_jobs SET
      status = ${snapshot.status},
      active = ${snapshot.active},
      progress = ${snapshot.progress},
      total = ${snapshot.total},
      current = ${snapshot.current},
      queued = ${snapshot.queued},
      failed = ${snapshot.failed},
      message = ${snapshot.message},
      snapshot_updated_at = ${snapshot.updatedAt},
      updated_at = ${snapshot.updatedAt}
    WHERE job_id = ${snapshot.jobId}
      AND generation = ${snapshot.generation}
      AND coalesce(snapshot_updated_at, updated_at) <= ${snapshot.updatedAt}
    RETURNING job_id AS "jobId"
  `;
  return rows.length === 1;
}

export async function persistQueueSendJobItems(
  jobId: string,
  items: QueueSendJobItemInput[],
): Promise<number> {
  if (!jobId || items.length === 0) return 0;
  await ensureQueueSendJobStoreSchema();
  // Audit PQ-7 (2026-07-13): one multi-row statement instead of one round-trip
  // per item (job start used to fire 2x N inserts for an N-order batch).
  const rowsJson = JSON.stringify(items.map((item) => ({
    order_id: item.orderId,
    client_id: item.clientId ?? null,
    attempt_count: normalizeNonNegativeInteger(item.attemptCount),
    generation: normalizeNonNegativeInteger(item.generation),
    state: item.state,
    blocked_reason: item.blockedReason ?? null,
    error_message: item.errorMessage ?? null,
    queue_entry_id: item.queueEntryId ?? null,
    tracking_number: item.trackingNumber ?? null,
    result: item.result ?? null,
  })));
  const persisted = await pg<Array<{ orderId: number }>>`
    INSERT INTO print_queue_batch_job_items (
      job_id,
      order_id,
      client_id,
      attempt_count,
      generation,
      state,
      blocked_reason,
      error_message,
      queue_entry_id,
      tracking_number,
      result,
      updated_at
    )
    SELECT
      ${jobId},
      x.order_id,
      x.client_id,
      x.attempt_count,
      x.generation,
      x.state,
      x.blocked_reason,
      x.error_message,
      x.queue_entry_id,
      x.tracking_number,
      x.result,
      now()
    FROM jsonb_to_recordset(${rowsJson}::jsonb) AS x(
      order_id integer,
      client_id integer,
      attempt_count integer,
      generation integer,
      state text,
      blocked_reason text,
      error_message text,
      queue_entry_id text,
      tracking_number text,
      result jsonb
    )
    JOIN print_queue_send_jobs AS jobs
      ON jobs.job_id = ${jobId}
      AND jobs.generation = x.generation
    ON CONFLICT (job_id, order_id) DO UPDATE SET
      client_id = EXCLUDED.client_id,
      attempt_count = CASE
        -- Per user override unlock shipped data on 2026-07-21: once the
        -- canonical ledger proves a durable receipt/shipment, start a separate
        -- bounded local queue-tail budget. No provider-pending or terminal row
        -- can otherwise lower its attempt counter.
        WHEN print_queue_batch_job_items.state IN ('provider_pending', 'provider_pending_recovery')
          AND EXCLUDED.state IN ('receipt_resume', 'shipment_persisted')
          THEN EXCLUDED.attempt_count
        ELSE greatest(
          print_queue_batch_job_items.attempt_count,
          EXCLUDED.attempt_count
        )
      END,
      generation = EXCLUDED.generation,
      state = EXCLUDED.state,
      blocked_reason = EXCLUDED.blocked_reason,
      error_message = EXCLUDED.error_message,
      queue_entry_id = EXCLUDED.queue_entry_id,
      tracking_number = EXCLUDED.tracking_number,
      result = EXCLUDED.result,
      updated_at = now()
    WHERE print_queue_batch_job_items.generation <= EXCLUDED.generation
      AND print_queue_batch_job_items.state NOT IN (
        'queued',
        'failed_retryable',
        'failed_terminal',
        'skipped_preflight',
        'preflight_blocked'
      )
    RETURNING order_id AS "orderId"
  `;
  return persisted.length;
}

export async function updateQueueSendJobItemState(
  jobId: string,
  orderId: number,
  patch: Omit<QueueSendJobItemInput, 'orderId'>,
): Promise<boolean> {
  return (await persistQueueSendJobItems(jobId, [{ ...patch, orderId }])) === 1;
}

export async function getQueueSendJobItemRecords(jobId: string): Promise<QueueSendJobItemRecord[]> {
  if (!jobId) return [];
  try {
    await ensureQueueSendJobStoreSchema();
    const rows = await pg<Array<{
      job_id: string;
      order_id: number;
      client_id: number | null;
      attempt_count: number | string;
      generation: number | string;
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
        attempt_count,
        generation,
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
      attemptCount: normalizeNonNegativeInteger(row.attempt_count),
      generation: normalizeNonNegativeInteger(row.generation),
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
    const rows = await pg<Array<{
      snapshot: unknown;
      generation: number;
      chunkSequence: number;
      updatedAt: string;
    }>>`
      SELECT
        snapshot,
        generation,
        current_chunk_sequence AS "chunkSequence",
        updated_at::text AS "updatedAt"
      FROM print_queue_send_jobs
      WHERE job_id = ${jobId}
      LIMIT 1
    `;
    return withExecutionMetadata(
      rows[0]?.snapshot,
      rows[0]?.generation,
      rows[0]?.chunkSequence,
      rows[0]?.updatedAt,
    );
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
    const rows = await pg<Array<{
      snapshot: unknown;
      generation: number;
      chunkSequence: number;
      updatedAt: string;
    }>>`
      SELECT
        snapshot,
        generation,
        current_chunk_sequence AS "chunkSequence",
        updated_at::text AS "updatedAt"
      FROM print_queue_send_jobs
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return withExecutionMetadata(
      rows[0]?.snapshot,
      rows[0]?.generation,
      rows[0]?.chunkSequence,
      rows[0]?.updatedAt,
    );
  } catch (err) {
    console.warn(
      '[print-queue-job-store] failed to read latest queue-send job:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Audit PQ-2: atomically lease stale durable jobs and increment their recovery
 * attempt before enqueue. SKIP LOCKED prevents two worker processes from
 * claiming the same parent job on the same reaper pass.
 */
export async function claimRecoverableQueueSendJobRecords(options: {
  staleAfterMs: number;
  maxAttempts: number;
  limit?: number;
}): Promise<QueueSendJobSnapshot[]> {
  const staleAfterSeconds = Math.max(1, Math.ceil(options.staleAfterMs / 1000));
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  try {
    await ensureQueueSendJobStoreSchema();
    // Per user override unlock shipped data on 2026-07-14: this updates only
    // print_queue_send_jobs orchestration metadata; it never touches orders,
    // shipments, labels, postage, inventory, or marketplace confirmation.
    const rows = await pg<Array<{
      snapshot: unknown;
      generation: number;
      chunkSequence: number;
      updatedAt: string;
    }>>`
      UPDATE print_queue_send_jobs AS jobs
      SET
        status = 'pending',
        active = true,
        generation = jobs.generation + 1,
        current_chunk_sequence = 1,
        claimed_at = NULL,
        heartbeat_at = NULL,
        cancel_requested_at = NULL,
        cancel_acknowledged_at = NULL,
        message = 'Recovery attempt claimed',
        snapshot = jobs.snapshot || jsonb_build_object(
          'status', 'pending',
          'active', true,
          'generation', jobs.generation + 1,
          'chunkSequence', 1,
          'message', 'Recovery attempt claimed',
          'errorMessage', null,
          'recoveryAttempts', jobs.generation + 1,
          'updatedAt', now(),
          'persistedAt', now()
        ),
        snapshot_updated_at = now(),
        updated_at = now()
      WHERE jobs.job_id IN (
        SELECT candidate.job_id
        FROM print_queue_send_jobs AS candidate
        WHERE candidate.status IN ('pending', 'running', 'interrupted')
          AND CASE
            WHEN candidate.status = 'running'
              THEN coalesce(candidate.heartbeat_at, candidate.updated_at)
            ELSE candidate.updated_at
          END < now() - (${staleAfterSeconds} * interval '1 second')
          AND candidate.generation < ${maxAttempts}
          AND (
            candidate.status <> 'interrupted'
            OR jsonb_array_length(coalesce(candidate.snapshot->'workerOrders', '[]'::jsonb)) > 0
          )
        ORDER BY candidate.updated_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        jobs.snapshot,
        jobs.generation,
        jobs.current_chunk_sequence AS "chunkSequence",
        jobs.updated_at::text AS "updatedAt"
    `;
    return rows
      .map((row) => withExecutionMetadata(
        row.snapshot,
        row.generation,
        row.chunkSequence,
        row.updatedAt,
      ))
      .filter((snapshot): snapshot is QueueSendJobSnapshot => Boolean(snapshot));
  } catch (err) {
    console.warn(
      '[print-queue-job-store] failed to claim recoverable queue-send jobs:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Atomically claim an operator-requested resume of safe, non-provider-pending items. */
export async function claimQueueSendJobManualResume(
  jobId: string,
  maxAttempts: number,
): Promise<QueueSendJobSnapshot | null> {
  if (!jobId) return null;
  await ensureQueueSendJobStoreSchema();
  const boundedMaxAttempts = Math.max(1, Math.floor(maxAttempts));
  // Per user override unlock shipped data on 2026-07-21: PS-444 updates only
  // durable Print Queue orchestration metadata. Provider-pending orders are
  // filtered by the worker planner before any provider-capable module runs.
  const rows = await pg<Array<{
    snapshot: unknown;
    generation: number;
    chunkSequence: number;
    updatedAt: string;
  }>>`
    UPDATE print_queue_send_jobs
    SET
      status = 'pending',
      active = true,
      generation = generation + 1,
      current_chunk_sequence = 1,
      claimed_at = NULL,
      heartbeat_at = NULL,
      cancel_requested_at = NULL,
      cancel_acknowledged_at = NULL,
      message = 'Safe-order resume requested',
      snapshot = snapshot || jsonb_build_object(
        'status', 'pending',
        'active', true,
        'generation', generation + 1,
        'chunkSequence', 1,
        'message', 'Safe-order resume requested',
        'errorMessage', null,
        'recoveryAttempts', generation + 1,
        'updatedAt', now(),
        'persistedAt', now()
      ),
      snapshot_updated_at = now(),
      updated_at = now()
    WHERE job_id = ${jobId}
      AND status = 'interrupted'
      AND generation < ${boundedMaxAttempts}
    RETURNING
      snapshot,
      generation,
      current_chunk_sequence AS "chunkSequence",
      updated_at::text AS "updatedAt"
  `;
  return withExecutionMetadata(
    rows[0]?.snapshot,
    rows[0]?.generation,
    rows[0]?.chunkSequence,
    rows[0]?.updatedAt,
  );
}

export async function readQueueSendJobRecoverySafety(jobId: string): Promise<{
  providerPendingCount: number;
}> {
  if (!jobId) return { providerPendingCount: 0 };
  await ensureQueueSendJobStoreSchema();
  // Per user override unlock shipped data on 2026-07-15: this is a read-only
  // recovery fence over Print Queue item sidecars. It does not inspect or
  // mutate orders, shipments, labels, postage, or marketplace notifications.
  const [row] = await pg<{ provider_pending_count: number | string }[]>`
    SELECT count(*) FILTER (
      WHERE state IN ('provider_pending', 'provider_pending_recovery')
    )::int AS provider_pending_count
    FROM print_queue_batch_job_items
    WHERE job_id = ${jobId}
  `;
  return { providerPendingCount: Number(row?.provider_pending_count ?? 0) || 0 };
}

export async function markQueueSendJobWorkerClaimed(
  jobId: string,
  recoveryAttempt: number,
  chunkSequence: number,
): Promise<boolean> {
  if (!jobId) return false;
  await ensureQueueSendJobStoreSchema();
  const normalizedAttempt = Math.max(0, Math.floor(recoveryAttempt));
  const normalizedChunkSequence = Math.max(1, Math.floor(chunkSequence));
  // Per user override unlock shipped data on 2026-07-21: PS-452 requires a
  // successful generation-matched durable metadata WRITE before any
  // provider-capable module is imported. A read-only/poisoned DB session or a
  // stale generation therefore fails closed with zero label/provider work.
  const rows = await pg<{ job_id: string }[]>`
    UPDATE print_queue_send_jobs
    SET
      status = 'running',
      active = true,
      claimed_at = now(),
      heartbeat_at = now(),
      message = 'Worker claim admitted',
      snapshot = snapshot || jsonb_build_object(
        'status', 'running',
        'active', true,
        'message', 'Worker claim admitted',
        'updatedAt', now(),
        'persistedAt', now()
      ),
      snapshot_updated_at = now(),
      updated_at = now()
    WHERE job_id = ${jobId}
      AND status = 'pending'
      AND generation = ${normalizedAttempt}
      AND current_chunk_sequence = ${normalizedChunkSequence}
    RETURNING job_id
  `;
  return rows.length === 1;
}

export async function heartbeatQueueSendJobWorkerClaim(
  jobId: string,
  generation: number,
  chunkSequence: number,
): Promise<boolean> {
  await ensureQueueSendJobStoreSchema();
  const rows = await pg<Array<{ jobId: string }>>`
    UPDATE print_queue_send_jobs
    SET heartbeat_at = now(), updated_at = now()
    WHERE job_id = ${jobId}
      AND generation = ${Math.max(0, Math.floor(generation))}
      AND current_chunk_sequence = ${Math.max(1, Math.floor(chunkSequence))}
    RETURNING job_id AS "jobId"
  `;
  return rows.length === 1;
}

export async function requestQueueSendJobCancellation(
  jobId: string,
  generation: number,
  chunkSequence: number,
): Promise<boolean> {
  await ensureQueueSendJobStoreSchema();
  const rows = await pg<Array<{ jobId: string }>>`
    UPDATE print_queue_send_jobs
    SET cancel_requested_at = now(), updated_at = now()
    WHERE job_id = ${jobId}
      AND status IN ('running', 'pending', 'interrupted')
      AND generation = ${Math.max(0, Math.floor(generation))}
      AND current_chunk_sequence = ${Math.max(1, Math.floor(chunkSequence))}
    RETURNING job_id AS "jobId"
  `;
  return rows.length === 1;
}

export async function acknowledgeQueueSendJobCancellation(
  jobId: string,
  generation: number,
  chunkSequence: number,
): Promise<boolean> {
  await ensureQueueSendJobStoreSchema();
  const rows = await pg<Array<{ jobId: string }>>`
    UPDATE print_queue_send_jobs
    SET cancel_acknowledged_at = now(), heartbeat_at = NULL, updated_at = now()
    WHERE job_id = ${jobId}
      AND generation = ${Math.max(0, Math.floor(generation))}
      AND current_chunk_sequence = ${Math.max(1, Math.floor(chunkSequence))}
    RETURNING job_id AS "jobId"
  `;
  return rows.length === 1;
}

/** Reserve the next chunk before publishing its pg-boss payload. */
export async function advanceQueueSendJobChunk(input: {
  jobId: string;
  generation: number;
  currentChunkSequence: number;
  nextChunkSequence: number;
}): Promise<boolean> {
  await ensureQueueSendJobStoreSchema();
  const rows = await pg<Array<{ jobId: string }>>`
    UPDATE print_queue_send_jobs
    SET
      status = 'pending',
      active = true,
      current_chunk_sequence = ${Math.max(1, Math.floor(input.nextChunkSequence))},
      snapshot = snapshot || jsonb_build_object(
        'status', 'pending',
        'active', true,
        'chunkSequence', ${Math.max(1, Math.floor(input.nextChunkSequence))},
        'updatedAt', now(),
        'persistedAt', now()
      ),
      snapshot_updated_at = now(),
      claimed_at = NULL,
      heartbeat_at = NULL,
      updated_at = now()
    WHERE job_id = ${input.jobId}
      AND status IN ('pending', 'interrupted')
      AND generation = ${Math.max(0, Math.floor(input.generation))}
      AND current_chunk_sequence = ${Math.max(1, Math.floor(input.currentChunkSequence))}
    RETURNING job_id AS "jobId"
  `;
  return rows.length === 1;
}

export async function claimQueueSendJobItemAttempt(input: {
  jobId: string;
  orderId: number;
  generation: number;
  chunkSequence: number;
  maxAttempts: number;
}): Promise<number | null> {
  // Per user override unlock shipped data on 2026-07-21: this claims only an
  // orchestration sidecar row before the existing provider boundary.
  await ensureQueueSendJobStoreSchema();
  const rows = await pg<Array<{ attemptCount: number }>>`
    UPDATE print_queue_batch_job_items
    SET
      attempt_count = attempt_count + 1,
      generation = ${Math.max(0, Math.floor(input.generation))},
      updated_at = now()
    WHERE job_id = ${input.jobId}
      AND order_id = ${input.orderId}
      AND state IN ('ready', 'validating_rate', 'acquiring_lock', 'receipt_resume', 'shipment_persisted')
      AND attempt_count < ${Math.max(1, Math.floor(input.maxAttempts))}
      AND generation <= ${Math.max(0, Math.floor(input.generation))}
      AND EXISTS (
        SELECT 1
        FROM print_queue_send_jobs AS jobs
        WHERE jobs.job_id = ${input.jobId}
          AND jobs.status = 'running'
          AND jobs.generation = ${Math.max(0, Math.floor(input.generation))}
          AND jobs.current_chunk_sequence = ${Math.max(1, Math.floor(input.chunkSequence))}
      )
    RETURNING attempt_count AS "attemptCount"
  `;
  return rows[0]?.attemptCount == null ? null : Number(rows[0].attemptCount);
}

export async function terminalizeExhaustedQueueSendJobItems(input: {
  jobId: string;
  generation: number;
  maxAttempts: number;
}): Promise<number> {
  await ensureQueueSendJobStoreSchema();
  const message = `Print Queue item parked after ${Math.max(1, Math.floor(input.maxAttempts))} interrupted attempts.`;
  const rows = await pg<Array<{ orderId: number }>>`
    UPDATE print_queue_batch_job_items
    SET
      state = 'failed_terminal',
      generation = ${Math.max(0, Math.floor(input.generation))},
      blocked_reason = 'recovery_attempts_exhausted',
      error_message = ${message},
      updated_at = now()
    WHERE job_id = ${input.jobId}
      AND state IN ('ready', 'validating_rate', 'acquiring_lock', 'receipt_resume', 'shipment_persisted')
      AND attempt_count >= ${Math.max(1, Math.floor(input.maxAttempts))}
      AND generation <= ${Math.max(0, Math.floor(input.generation))}
      AND EXISTS (
        SELECT 1
        FROM print_queue_send_jobs AS jobs
        WHERE jobs.job_id = ${input.jobId}
          AND jobs.generation = ${Math.max(0, Math.floor(input.generation))}
      )
    RETURNING order_id AS "orderId"
  `;
  return rows.length;
}

/** Persist a visible terminal/intermediate interruption without rewriting order data. */
export async function markQueueSendJobInterrupted(
  jobId: string,
  message: string,
  expectedGeneration?: number,
  expectedChunkSequence?: number,
): Promise<boolean> {
  if (!jobId) return false;
  await ensureQueueSendJobStoreSchema();
  // Per user override unlock shipped data on 2026-07-21: interruption is
  // durable queue metadata only. Both execution coordinates are fenced so a
  // late chunk cannot interrupt its already-reserved successor; this performs
  // no label/postage or shipped-history mutation.
  const rows = await pg<{ job_id: string }[]>`
    UPDATE print_queue_send_jobs
    SET
      status = 'interrupted',
      active = false,
      message = ${message},
      snapshot = snapshot || jsonb_build_object(
        'status', 'interrupted',
        'active', false,
        'message', ${message}::text,
        'errorMessage', ${message}::text,
        'updatedAt', now(),
        'persistedAt', now()
      ),
      snapshot_updated_at = now(),
      heartbeat_at = NULL,
      cancel_acknowledged_at = now(),
      updated_at = now()
    WHERE job_id = ${jobId}
      AND status IN ('pending', 'running', 'interrupted')
      AND (${expectedGeneration == null ? -1 : Math.max(0, Math.floor(expectedGeneration))} < 0
        OR generation = ${expectedGeneration == null ? -1 : Math.max(0, Math.floor(expectedGeneration))})
      AND (${expectedChunkSequence == null ? -1 : Math.max(1, Math.floor(expectedChunkSequence))} < 0
        OR current_chunk_sequence = ${expectedChunkSequence == null ? -1 : Math.max(1, Math.floor(expectedChunkSequence))})
    RETURNING job_id
  `;
  return rows.length > 0;
}

export async function markQueueSendJobReconciliationWaiting(
  jobId: string,
  message: string,
  expectedGeneration?: number,
): Promise<boolean> {
  if (!jobId) return false;
  await ensureQueueSendJobStoreSchema();
  // Provider reconciliation is a read-only observation pass, not a replay.
  // Keep the generation monotonic as an execution fence; per-item mutation
  // attempts are not incremented by reconciliation-only passes.
  const rows = await pg<{ job_id: string }[]>`
    UPDATE print_queue_send_jobs
    SET
      status = 'interrupted',
      active = false,
      message = ${message},
      snapshot = snapshot || jsonb_build_object(
        'status', 'interrupted',
        'active', false,
        'message', ${message}::text,
        'errorMessage', ${message}::text,
        'recoveryAttempts', generation,
        'updatedAt', now(),
        'persistedAt', now()
      ),
      snapshot_updated_at = now(),
      heartbeat_at = NULL,
      updated_at = now()
    WHERE job_id = ${jobId}
      AND status IN ('pending', 'running', 'interrupted')
      AND (${expectedGeneration == null ? -1 : Math.max(0, Math.floor(expectedGeneration))} < 0
        OR generation = ${expectedGeneration == null ? -1 : Math.max(0, Math.floor(expectedGeneration))})
    RETURNING job_id
  `;
  return rows.length > 0;
}

/** Mark stale recoverable jobs terminal once their durable recovery budget is spent. */
export async function interruptExhaustedQueueSendJobs(options: {
  staleAfterMs: number;
  maxAttempts: number;
}): Promise<number> {
  const staleAfterSeconds = Math.max(1, Math.ceil(options.staleAfterMs / 1000));
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  await ensureQueueSendJobStoreSchema();
  const message = `Queue job reached its ${maxAttempts}-generation recovery cap; safe unfinished items were parked for review.`;
  // Per user override unlock shipped data on 2026-07-21: attempt exhaustion
  // updates orchestration metadata only; it cannot buy or mutate a label.
  const rows = await pg<Array<{ exhaustedCount: number | string }>>`
    WITH exhausted AS (
      UPDATE print_queue_send_jobs
      SET
        status = 'error',
        active = false,
        generation = generation + 1,
        message = ${message},
        snapshot = snapshot || jsonb_build_object(
          'status', 'error',
          'active', false,
          'generation', generation + 1,
          'recoveryAttempts', generation + 1,
          'message', ${message}::text,
          'errorMessage', ${message}::text,
          'updatedAt', now(),
          'persistedAt', now()
        ),
        snapshot_updated_at = now(),
        heartbeat_at = NULL,
        updated_at = now()
      WHERE status IN ('pending', 'running', 'interrupted')
        AND CASE
          WHEN status = 'running' THEN coalesce(heartbeat_at, updated_at)
          ELSE updated_at
        END < now() - (${staleAfterSeconds} * interval '1 second')
        AND generation >= ${maxAttempts}
      RETURNING job_id, generation
    ), parked AS (
      UPDATE print_queue_batch_job_items AS items
      SET
        state = 'failed_terminal',
        generation = exhausted.generation,
        blocked_reason = 'parent_recovery_attempts_exhausted',
        error_message = ${message},
        updated_at = now()
      FROM exhausted
      WHERE items.job_id = exhausted.job_id
        AND items.state IN ('ready', 'validating_rate', 'acquiring_lock', 'receipt_resume', 'shipment_persisted')
        AND items.generation < exhausted.generation
      RETURNING items.job_id
    )
    SELECT count(*)::integer AS "exhaustedCount"
    FROM exhausted
  `;
  return Number(rows[0]?.exhaustedCount ?? 0);
}
