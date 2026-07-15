import { sql as pg } from '../../db/client.js';
import { assertRuntimeSchemaReady } from '../runtime-schema-readiness.js';
import type { MergeJobSnapshot } from '../print-queue.js';
import type { PrintQueueEntry } from '../../db/schema/print-queue.js';

export type PrintMergeWorkerInput = {
  entries: PrintQueueEntry[];
  mergeHeaders: boolean;
  requestOrigin?: string;
};

export type PrintMergeJobClaim = {
  snapshot: MergeJobSnapshot;
  input: PrintMergeWorkerInput;
  generation: number;
};

function parseMergeJobSnapshot(value: unknown): MergeJobSnapshot | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as MergeJobSnapshot;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? (value as MergeJobSnapshot) : null;
}

function withGeneration(
  value: unknown,
  generation: unknown,
  durableUpdatedAt?: unknown,
): MergeJobSnapshot | null {
  const snapshot = parseMergeJobSnapshot(value);
  if (!snapshot) return null;
  const parsed = Number(generation);
  const updatedAt = typeof durableUpdatedAt === 'string'
    ? durableUpdatedAt
    : durableUpdatedAt instanceof Date
      ? durableUpdatedAt.toISOString()
      : snapshot.persistedAt;
  return {
    ...snapshot,
    generation: Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : snapshot.generation ?? 0,
    persistedAt: updatedAt,
  };
}

function parseWorkerInput(value: unknown): PrintMergeWorkerInput | null {
  const parsed = typeof value === 'string'
    ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })()
    : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const input = parsed as Partial<PrintMergeWorkerInput>;
  if (!Array.isArray(input.entries) || input.entries.length === 0) return null;
  return {
    entries: input.entries as PrintQueueEntry[],
    mergeHeaders: input.mergeHeaders !== false,
    requestOrigin: typeof input.requestOrigin === 'string' ? input.requestOrigin : undefined,
  };
}

export async function ensureMergeJobStoreSchema(): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: migration 0064 owns
  // merge-job metadata only; no order, shipment, label, or postage row is changed.
  await assertRuntimeSchemaReady();
}

export async function persistMergeJobRecord(
  snapshot: MergeJobSnapshot,
  options: { input?: PrintMergeWorkerInput } = {},
): Promise<boolean> {
  await ensureMergeJobStoreSchema();
  const clientIdsJson = JSON.stringify(snapshot.clientIds ?? []);
  const snapshotJson = JSON.stringify(snapshot);
  const inputJson = JSON.stringify(options.input ?? {});
  const rows = await pg<Array<{ jobId: string }>>`
    INSERT INTO print_queue_merge_jobs (
      job_id,
      status,
      active,
      client_ids,
      progress,
      total,
      current,
      message,
      file_name,
      error_message,
      snapshot,
      input_payload,
      generation,
      snapshot_updated_at,
      created_at,
      updated_at
    )
    VALUES (
      ${snapshot.jobId},
      ${snapshot.status},
      ${snapshot.active},
      ${clientIdsJson}::jsonb,
      ${snapshot.progress},
      ${snapshot.total},
      ${snapshot.current},
      ${snapshot.message},
      ${snapshot.fileName},
      ${snapshot.errorMessage},
      ${snapshotJson}::jsonb,
      ${inputJson}::jsonb,
      ${snapshot.generation},
      ${snapshot.persistedAt},
      ${snapshot.createdAt},
      ${snapshot.persistedAt}
    )
    ON CONFLICT (job_id) DO UPDATE SET
      status = ${snapshot.status},
      active = ${snapshot.active},
      client_ids = ${clientIdsJson}::jsonb,
      progress = ${snapshot.progress},
      total = ${snapshot.total},
      current = ${snapshot.current},
      message = ${snapshot.message},
      file_name = ${snapshot.fileName},
      error_message = ${snapshot.errorMessage},
      snapshot = ${snapshotJson}::jsonb,
      input_payload = CASE
        WHEN ${inputJson}::jsonb = '{}'::jsonb THEN print_queue_merge_jobs.input_payload
        ELSE ${inputJson}::jsonb
      END,
      snapshot_updated_at = ${snapshot.persistedAt},
      updated_at = ${snapshot.persistedAt}
    WHERE print_queue_merge_jobs.generation = ${snapshot.generation}
      AND print_queue_merge_jobs.snapshot_updated_at <= ${snapshot.persistedAt}
    RETURNING job_id AS "jobId"
  `;
  return rows.length === 1;
}

export async function getMergeJobRecord(jobId: string): Promise<MergeJobSnapshot | null> {
  if (!jobId) return null;
  try {
    await ensureMergeJobStoreSchema();
    const rows = await pg<Array<{ snapshot: unknown; generation: number; updatedAt: string }>>`
      SELECT snapshot, generation, updated_at::text AS "updatedAt"
      FROM print_queue_merge_jobs
      WHERE job_id = ${jobId}
      LIMIT 1
    `;
    return withGeneration(rows[0]?.snapshot, rows[0]?.generation, rows[0]?.updatedAt);
  } catch (err) {
    console.warn(
      '[print-queue-merge-job-store] failed to read merge job:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function getLatestMergeJobRecord(): Promise<MergeJobSnapshot | null> {
  try {
    await ensureMergeJobStoreSchema();
    const rows = await pg<Array<{ snapshot: unknown; generation: number; updatedAt: string }>>`
      SELECT snapshot, generation, updated_at::text AS "updatedAt"
      FROM print_queue_merge_jobs
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return withGeneration(rows[0]?.snapshot, rows[0]?.generation, rows[0]?.updatedAt);
  } catch (err) {
    console.warn(
      '[print-queue-merge-job-store] failed to read latest merge job:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function claimPrintMergeJobRecord(
  jobId: string,
  input: { staleAfterMs: number; now?: Date },
): Promise<PrintMergeJobClaim | null> {
  await ensureMergeJobStoreSchema();
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - Math.max(1, input.staleAfterMs)).toISOString();
  const rows = await pg<Array<{
    snapshot: unknown;
    inputPayload: unknown;
    generation: number;
  }>>`
    UPDATE print_queue_merge_jobs
    SET status = 'running',
        generation = generation + 1,
        claimed_at = ${now.toISOString()},
        heartbeat_at = ${now.toISOString()},
        cancel_requested_at = NULL,
        cancel_acknowledged_at = NULL,
        updated_at = ${now.toISOString()}
    WHERE job_id = ${jobId}
      AND active = true
      AND (
        status = 'pending'
        OR heartbeat_at IS NULL
        OR heartbeat_at < ${staleBefore}
      )
    RETURNING snapshot, input_payload AS "inputPayload", generation
  `;
  const row = rows[0];
  if (!row) return null;
  const snapshot = withGeneration(row.snapshot, row.generation);
  const workerInput = parseWorkerInput(row.inputPayload);
  if (!snapshot || !workerInput) return null;
  return { snapshot, input: workerInput, generation: row.generation };
}

export async function heartbeatPrintMergeJobRecord(
  jobId: string,
  generation: number,
): Promise<boolean> {
  const rows = await pg<Array<{ jobId: string }>>`
    UPDATE print_queue_merge_jobs
    SET heartbeat_at = now(), updated_at = now()
    WHERE job_id = ${jobId}
      AND generation = ${generation}
      AND active = true
    RETURNING job_id AS "jobId"
  `;
  return rows.length === 1;
}

export async function requestPrintMergeJobCancellation(
  jobId: string,
  generation: number,
): Promise<void> {
  await pg`
    UPDATE print_queue_merge_jobs
    SET cancel_requested_at = now(), updated_at = now()
    WHERE job_id = ${jobId} AND generation = ${generation} AND active = true
  `;
}

export async function acknowledgePrintMergeJobCancellation(
  jobId: string,
  generation: number,
): Promise<void> {
  await pg`
    UPDATE print_queue_merge_jobs
    SET cancel_acknowledged_at = now(), updated_at = now()
    WHERE job_id = ${jobId} AND generation = ${generation}
  `;
}

export async function listRecoverablePrintMergeJobIds(input: {
  staleAfterMs: number;
  limit?: number;
}): Promise<string[]> {
  const staleBefore = new Date(Date.now() - Math.max(1, input.staleAfterMs)).toISOString();
  const rows = await pg<Array<{ jobId: string }>>`
    SELECT job_id AS "jobId"
    FROM print_queue_merge_jobs
    WHERE active = true
      AND (
        status = 'pending'
        OR heartbeat_at IS NULL
        OR heartbeat_at < ${staleBefore}
      )
    ORDER BY created_at ASC
    LIMIT ${Math.max(1, Math.min(100, input.limit ?? 25))}
  `;
  return rows.map((row) => row.jobId);
}

export async function getActivePrintMergeEntryIds(): Promise<Set<string>> {
  const rows = await pg<Array<{ inputPayload: unknown }>>`
    SELECT input_payload AS "inputPayload"
    FROM print_queue_merge_jobs
    WHERE active = true
  `;
  const ids = new Set<string>();
  for (const row of rows) {
    const input = parseWorkerInput(row.inputPayload);
    for (const entry of input?.entries ?? []) {
      if (entry.id) ids.add(entry.id);
    }
  }
  return ids;
}
