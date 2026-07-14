import { sql as pg } from '../db/client.js';
import { advisoryLockKeyPair } from '../lib/advisory-lock';
import type { RateBrowseWorkflowSnapshot } from './rate-browse-workflow-types';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

export type RateBrowseJobPriority = 'manual' | 'preflight' | 'backfill';

export type RateBrowseJobReservation = {
  snapshot: RateBrowseWorkflowSnapshot;
  created: boolean;
};

type ProviderStatusRow = {
  providerKey: string;
  carrierId: string | null;
  accountId: string | null;
  carrierCode: string | null;
  carrierName: string | null;
  source: string;
  status: string;
  rateCount: number;
  durationMs: number | null;
  limiterWaitMs: number | null;
  diagnostics: Record<string, unknown>;
};

function parseRateBrowseWorkflowSnapshot(value: unknown): RateBrowseWorkflowSnapshot | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as RateBrowseWorkflowSnapshot;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value as RateBrowseWorkflowSnapshot;
  return null;
}

function activeForSnapshot(snapshot: RateBrowseWorkflowSnapshot): boolean {
  return snapshot.phase === 'queued' || snapshot.phase === 'running' || snapshot.phase === 'partial';
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resultFromSnapshot(snapshot: RateBrowseWorkflowSnapshot): Record<string, unknown> {
  return record(snapshot.result);
}

function timingRowsByCarrier(result: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const timing = record(result.rateBrowseTiming);
  const rows = Array.isArray(timing.carriers) ? timing.carriers : [];
  const byCarrier = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const current = record(row);
    const carrierId = text(current.carrierId);
    if (carrierId) byCarrier.set(carrierId, current);
  }
  return byCarrier;
}

export async function ensureRateBrowseJobStoreSchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}

export function extractRateBrowseProviderStatuses(snapshot: RateBrowseWorkflowSnapshot): ProviderStatusRow[] {
  const result = resultFromSnapshot(snapshot);
  const carrierStatuses = Array.isArray(result.carrierStatuses) ? result.carrierStatuses : [];
  const timingByCarrier = timingRowsByCarrier(result);
  return carrierStatuses
    .map((row): ProviderStatusRow | null => {
      const status = record(row);
      const carrierId = text(status.carrierId);
      if (!carrierId) return null;
      const timing = timingByCarrier.get(carrierId) ?? {};
      const source = text(status.source) ?? text(timing.source) ?? 'unknown';
      const accountId = text(status.accountId) ?? text(timing.accountId);
      const providerKey = `${source}:${accountId ?? carrierId}`;
      const durationMs = num(status.durationMs) ?? num(timing.durationMs);
      const limiterWaitMs = num(status.limiterWaitMs) ?? num(timing.limiterWaitMs);
      return {
        providerKey,
        carrierId,
        accountId,
        carrierCode: text(status.carrierCode) ?? text(timing.carrierCode),
        carrierName: text(status.carrierName) ?? text(status.nickname) ?? text(timing.carrierName),
        source,
        status: text(timing.outcome) ?? text(timing.status) ?? text(status.status) ?? 'unknown',
        rateCount: Math.max(0, Math.round(num(status.rateCount) ?? num(timing.rateCount) ?? 0)),
        durationMs: durationMs == null ? null : Math.max(0, Math.round(durationMs)),
        limiterWaitMs: limiterWaitMs == null ? null : Math.max(0, Math.round(limiterWaitMs)),
        diagnostics: {
          ...timing,
          ...status,
          displayStatus: text(status.status),
        },
      };
    })
    .filter((row): row is ProviderStatusRow => Boolean(row));
}

async function persistRateBrowseProviderStatuses(snapshot: RateBrowseWorkflowSnapshot): Promise<void> {
  const rows = extractRateBrowseProviderStatuses(snapshot);
  if (!rows.length) return;
  for (const row of rows) {
    const diagnosticsJson = JSON.stringify(row.diagnostics);
    await pg`
      INSERT INTO rate_browse_job_provider_statuses (
        job_id,
        provider_key,
        carrier_id,
        account_id,
        carrier_code,
        carrier_name,
        source,
        status,
        rate_count,
        duration_ms,
        limiter_wait_ms,
        diagnostics,
        updated_at
      )
      VALUES (
        ${snapshot.jobId},
        ${row.providerKey},
        ${row.carrierId},
        ${row.accountId},
        ${row.carrierCode},
        ${row.carrierName},
        ${row.source},
        ${row.status},
        ${row.rateCount},
        ${row.durationMs},
        ${row.limiterWaitMs},
        ${diagnosticsJson}::jsonb,
        ${snapshot.updatedAt}
      )
      ON CONFLICT (job_id, provider_key) DO UPDATE SET
        carrier_id = ${row.carrierId},
        account_id = ${row.accountId},
        carrier_code = ${row.carrierCode},
        carrier_name = ${row.carrierName},
        source = ${row.source},
        status = ${row.status},
        rate_count = ${row.rateCount},
        duration_ms = ${row.durationMs},
        limiter_wait_ms = ${row.limiterWaitMs},
        diagnostics = ${diagnosticsJson}::jsonb,
        updated_at = ${snapshot.updatedAt}
    `;
  }
}

export async function persistRateBrowseJobRecord(
  snapshot: RateBrowseWorkflowSnapshot,
  options: { priority?: RateBrowseJobPriority } = {},
): Promise<void> {
  await ensureRateBrowseJobStoreSchema();
  const active = activeForSnapshot(snapshot);
  const priority = options.priority ?? 'manual';
  const diagnosticsJson = JSON.stringify(snapshot.diagnostics ?? {});
  const snapshotJson = JSON.stringify(snapshot);
  await pg`
    INSERT INTO rate_browse_jobs (
      job_id,
      request_key,
      order_id,
      priority,
      status,
      active,
      total_carriers,
      completed_carriers,
      successful_carriers,
      failed_carriers,
      rates_count,
      message,
      diagnostics,
      snapshot,
      created_at,
      updated_at,
      finished_at
    )
    VALUES (
      ${snapshot.jobId},
      ${snapshot.requestKey},
      ${snapshot.orderId},
      ${priority},
      ${snapshot.phase},
      ${active},
      ${snapshot.totalCarriers},
      ${snapshot.completedCarriers},
      ${snapshot.successfulCarriers},
      ${snapshot.failedCarriers},
      ${snapshot.ratesCount},
      ${snapshot.message},
      ${diagnosticsJson}::jsonb,
      ${snapshotJson}::jsonb,
      ${snapshot.startedAt},
      ${snapshot.updatedAt},
      ${snapshot.finishedAt}
    )
    ON CONFLICT (job_id) DO UPDATE SET
      request_key = ${snapshot.requestKey},
      order_id = ${snapshot.orderId},
      priority = COALESCE(rate_browse_jobs.priority, ${priority}),
      status = ${snapshot.phase},
      active = ${active},
      total_carriers = ${snapshot.totalCarriers},
      completed_carriers = ${snapshot.completedCarriers},
      successful_carriers = ${snapshot.successfulCarriers},
      failed_carriers = ${snapshot.failedCarriers},
      rates_count = ${snapshot.ratesCount},
      message = ${snapshot.message},
      diagnostics = ${diagnosticsJson}::jsonb,
      snapshot = ${snapshotJson}::jsonb,
      updated_at = ${snapshot.updatedAt},
      finished_at = ${snapshot.finishedAt}
  `;
  await persistRateBrowseProviderStatuses(snapshot);
}

export async function getRateBrowseJobRecord(jobId: string): Promise<RateBrowseWorkflowSnapshot | null> {
  if (!jobId) return null;
  try {
    await ensureRateBrowseJobStoreSchema();
    const rows = await pg<Array<{ snapshot: unknown }>>`
      SELECT snapshot
      FROM rate_browse_jobs
      WHERE job_id = ${jobId}
      LIMIT 1
    `;
    return parseRateBrowseWorkflowSnapshot(rows[0]?.snapshot);
  } catch (err) {
    console.warn(
      '[rate-browse-job-store] failed to read rate browse job:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function getActiveRateBrowseJobRecordByRequestKey(
  requestKey: string,
): Promise<RateBrowseWorkflowSnapshot | null> {
  if (!requestKey) return null;
  await ensureRateBrowseJobStoreSchema();
  const rows = await pg<Array<{ snapshot: unknown }>>`
    SELECT snapshot
    FROM rate_browse_jobs
    WHERE request_key = ${requestKey}
      AND active = true
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  return parseRateBrowseWorkflowSnapshot(rows[0]?.snapshot);
}

type RateBrowseReservationLock = {
  release: () => Promise<void>;
};

async function tryRateBrowseJobReservationLock(requestKey: string): Promise<RateBrowseReservationLock | null> {
  const [classid, objid] = advisoryLockKeyPair(`rate-browse-job:${requestKey}`);
  const reserved = await pg.reserve();
  try {
    const rows = await reserved<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(${classid}, ${objid}) AS acquired
    `;
    if (rows[0]?.acquired !== true) {
      reserved.release();
      return null;
    }
    return {
      release: async () => {
        try {
          await reserved`SELECT pg_advisory_unlock(${classid}, ${objid})`;
        } finally {
          reserved.release();
        }
      },
    };
  } catch (err) {
    reserved.release();
    throw err;
  }
}

function lockBusySnapshot(snapshot: RateBrowseWorkflowSnapshot): RateBrowseWorkflowSnapshot {
  return {
    ...snapshot,
    message: 'Rate browse workflow queued; durable duplicate lock was busy',
    diagnostics: {
      ...snapshot.diagnostics,
      durableReservation: 'lock_busy_starting_independent_job',
    },
  };
}

export async function reserveRateBrowseJobRecord(
  snapshot: RateBrowseWorkflowSnapshot,
  options: { priority?: RateBrowseJobPriority } = {},
): Promise<RateBrowseJobReservation> {
  const requestKey = snapshot.requestKey;
  if (!requestKey) {
    await persistRateBrowseJobRecord(snapshot, options);
    return { snapshot, created: true };
  }

  const existing = await getActiveRateBrowseJobRecordByRequestKey(requestKey);
  if (existing) return { snapshot: existing, created: false };

  const lock = await tryRateBrowseJobReservationLock(requestKey);
  if (!lock) {
    const active = await getActiveRateBrowseJobRecordByRequestKey(requestKey);
    if (active) return { snapshot: active, created: false };
    return { snapshot: lockBusySnapshot(snapshot), created: true };
  }

  try {
    const active = await getActiveRateBrowseJobRecordByRequestKey(requestKey);
    if (active) return { snapshot: active, created: false };
    await persistRateBrowseJobRecord(snapshot, options);
    return { snapshot, created: true };
  } finally {
    await lock.release();
  }
}
