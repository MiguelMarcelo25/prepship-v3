import { sql as pg } from '../../db/client.js';
import { assertRuntimeSchemaReady } from '../runtime-schema-readiness.js';
import type { MergeJobSnapshot } from '../print-queue.js';

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

export async function ensureMergeJobStoreSchema(): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: migration 0064 owns
  // merge-job metadata only; no order, shipment, label, or postage row is changed.
  await assertRuntimeSchemaReady();
}

export async function persistMergeJobRecord(snapshot: MergeJobSnapshot): Promise<void> {
  await ensureMergeJobStoreSchema();
  const clientIdsJson = JSON.stringify(snapshot.clientIds ?? []);
  const snapshotJson = JSON.stringify(snapshot);
  await pg`
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
      updated_at = ${snapshot.persistedAt}
    WHERE print_queue_merge_jobs.updated_at <= ${snapshot.persistedAt}
  `;
}

export async function getMergeJobRecord(jobId: string): Promise<MergeJobSnapshot | null> {
  if (!jobId) return null;
  try {
    await ensureMergeJobStoreSchema();
    const rows = await pg<{ snapshot: unknown }[]>`
      SELECT snapshot
      FROM print_queue_merge_jobs
      WHERE job_id = ${jobId}
      LIMIT 1
    `;
    return parseMergeJobSnapshot(rows[0]?.snapshot);
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
    const rows = await pg<{ snapshot: unknown }[]>`
      SELECT snapshot
      FROM print_queue_merge_jobs
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return parseMergeJobSnapshot(rows[0]?.snapshot);
  } catch (err) {
    console.warn(
      '[print-queue-merge-job-store] failed to read latest merge job:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
