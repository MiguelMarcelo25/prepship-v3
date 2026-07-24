import { sql as pg } from '../db/client.js';
import type { RateBrowseWorkflowSnapshot } from './rate-browse-workflow-types';
import { RATE_BROWSE_MAX_EXECUTION_GENERATIONS } from './rate-browse-worker-policy.js';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

export type RateBrowseJobPriority = 'manual' | 'preflight' | 'backfill';

export type RateBrowseJobReservation = {
  snapshot: RateBrowseWorkflowSnapshot;
  created: boolean;
};

export type RateBrowseWorkerInput = {
  body: Record<string, unknown>;
  canViewFinancials: boolean;
  includeCachedPartial: boolean;
  priority: RateBrowseJobPriority;
};

export type RateBrowseJobClaim = {
  snapshot: RateBrowseWorkflowSnapshot;
  input: RateBrowseWorkerInput;
  generation: number;
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

function snapshotWithGeneration(
  value: unknown,
  generation: unknown,
  durableUpdatedAt?: unknown,
): RateBrowseWorkflowSnapshot | null {
  const snapshot = parseRateBrowseWorkflowSnapshot(value);
  if (!snapshot) return null;
  return {
    ...snapshot,
    generation: Math.max(0, Math.trunc(num(generation) ?? snapshot.generation ?? 0)),
    updatedAt: typeof durableUpdatedAt === 'string'
      ? durableUpdatedAt
      : durableUpdatedAt instanceof Date
        ? durableUpdatedAt.toISOString()
        : snapshot.updatedAt,
  };
}

function parseWorkerInput(value: unknown): RateBrowseWorkerInput | null {
  const parsed = typeof value === 'string'
    ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })()
    : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const input = parsed as Partial<RateBrowseWorkerInput>;
  if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) return null;
  if (typeof input.canViewFinancials !== 'boolean') return null;
  return {
    body: input.body as Record<string, unknown>,
    canViewFinancials: input.canViewFinancials,
    includeCachedPartial: input.includeCachedPartial === true,
    priority: input.priority === 'preflight' || input.priority === 'backfill' ? input.priority : 'manual',
  };
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
      SELECT
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
      FROM rate_browse_jobs
      WHERE job_id = ${snapshot.jobId}
        AND generation = ${snapshot.generation}
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
      WHERE rate_browse_job_provider_statuses.updated_at <= ${snapshot.updatedAt}
    `;
  }
}

export async function persistRateBrowseJobRecord(
  snapshot: RateBrowseWorkflowSnapshot,
  options: { priority?: RateBrowseJobPriority; workerInput?: RateBrowseWorkerInput } = {},
): Promise<boolean> {
  await ensureRateBrowseJobStoreSchema();
  const active = activeForSnapshot(snapshot);
  const priority = options.priority ?? 'manual';
  const diagnosticsJson = JSON.stringify(snapshot.diagnostics ?? {});
  const snapshotJson = JSON.stringify(snapshot);
  const requestPayloadJson = JSON.stringify(options.workerInput ?? {});
  const rows = await pg<Array<{ jobId: string }>>`
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
      request_payload,
      generation,
      snapshot_updated_at,
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
      ${requestPayloadJson}::jsonb,
      ${snapshot.generation},
      ${snapshot.updatedAt},
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
      request_payload = CASE
        WHEN ${requestPayloadJson}::jsonb = '{}'::jsonb THEN rate_browse_jobs.request_payload
        ELSE ${requestPayloadJson}::jsonb
      END,
      snapshot_updated_at = ${snapshot.updatedAt},
      updated_at = ${snapshot.updatedAt},
      finished_at = ${snapshot.finishedAt}
    WHERE rate_browse_jobs.generation = ${snapshot.generation}
      AND rate_browse_jobs.snapshot_updated_at <= ${snapshot.updatedAt}
    RETURNING job_id AS "jobId"
  `;
  if (rows.length > 0) await persistRateBrowseProviderStatuses(snapshot);
  return rows.length > 0;
}

export async function getRateBrowseJobRecord(jobId: string): Promise<RateBrowseWorkflowSnapshot | null> {
  if (!jobId) return null;
  try {
    await ensureRateBrowseJobStoreSchema();
    const rows = await pg<Array<{ snapshot: unknown; generation: number; updatedAt: string }>>`
      SELECT snapshot, generation, updated_at::text AS "updatedAt"
      FROM rate_browse_jobs
      WHERE job_id = ${jobId}
      LIMIT 1
    `;
    return snapshotWithGeneration(rows[0]?.snapshot, rows[0]?.generation, rows[0]?.updatedAt);
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
  const rows = await pg<Array<{ snapshot: unknown; generation: number; updatedAt: string }>>`
    SELECT snapshot, generation, updated_at::text AS "updatedAt"
    FROM rate_browse_jobs
    WHERE request_key = ${requestKey}
      AND active = true
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  return snapshotWithGeneration(rows[0]?.snapshot, rows[0]?.generation, rows[0]?.updatedAt);
}

export async function reserveRateBrowseJobRecord(
  snapshot: RateBrowseWorkflowSnapshot,
  options: { priority?: RateBrowseJobPriority; workerInput: RateBrowseWorkerInput },
): Promise<RateBrowseJobReservation> {
  const requestKey = snapshot.requestKey;
  if (!requestKey) {
    await persistRateBrowseJobRecord(snapshot, options);
    return { snapshot, created: true };
  }

  const existing = await getActiveRateBrowseJobRecordByRequestKey(requestKey);
  if (existing) return { snapshot: existing, created: false };
  try {
    await persistRateBrowseJobRecord(snapshot, options);
    return { snapshot, created: true };
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== '23505') throw error;
    const active = await getActiveRateBrowseJobRecordByRequestKey(requestKey);
    if (active) return { snapshot: active, created: false };
    throw error;
  }
}

export async function claimRateBrowseJobRecord(
  jobId: string,
  options: { staleAfterMs: number; now?: Date } = { staleAfterMs: 60_000 },
): Promise<RateBrowseJobClaim | null> {
  await ensureRateBrowseJobStoreSchema();
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - Math.max(1, options.staleAfterMs)).toISOString();
  const rows = await pg<Array<{
    snapshot: unknown;
    requestPayload: unknown;
    generation: number;
  }>>`
    UPDATE rate_browse_jobs
    SET status = 'running',
        generation = generation + 1,
        claimed_at = ${now.toISOString()},
        heartbeat_at = ${now.toISOString()},
        cancel_requested_at = NULL,
        cancel_acknowledged_at = NULL,
        updated_at = ${now.toISOString()}
    WHERE job_id = ${jobId}
      AND active = true
      AND generation < ${RATE_BROWSE_MAX_EXECUTION_GENERATIONS}
      AND (
        status = 'queued'
        OR heartbeat_at IS NULL
        OR heartbeat_at < ${staleBefore}
      )
    RETURNING
      snapshot,
      request_payload AS "requestPayload",
      generation
  `;
  const row = rows[0];
  if (!row) return null;
  const snapshot = snapshotWithGeneration(row.snapshot, row.generation);
  const input = parseWorkerInput(row.requestPayload);
  if (!snapshot || !input) return null;
  return { snapshot, input, generation: row.generation };
}

export async function heartbeatRateBrowseJobRecord(
  jobId: string,
  generation: number,
): Promise<boolean> {
  const rows = await pg<Array<{ jobId: string }>>`
    UPDATE rate_browse_jobs
    SET heartbeat_at = now(), updated_at = now()
    WHERE job_id = ${jobId}
      AND generation = ${generation}
      AND active = true
    RETURNING job_id AS "jobId"
  `;
  return rows.length === 1;
}

export async function requestRateBrowseJobCancellation(
  jobId: string,
  generation: number,
): Promise<void> {
  await pg`
    UPDATE rate_browse_jobs
    SET cancel_requested_at = now(), updated_at = now()
    WHERE job_id = ${jobId} AND generation = ${generation} AND active = true
  `;
}

export async function acknowledgeRateBrowseJobCancellation(
  jobId: string,
  generation: number,
): Promise<void> {
  await pg`
    UPDATE rate_browse_jobs
    SET cancel_acknowledged_at = now(), updated_at = now()
    WHERE job_id = ${jobId} AND generation = ${generation}
  `;
}

export async function listRecoverableRateBrowseJobIds(input: {
  staleAfterMs: number;
  limit?: number;
}): Promise<string[]> {
  await ensureRateBrowseJobStoreSchema();
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - Math.max(1, input.staleAfterMs)).toISOString();
  const exhaustedMessage =
    `Rate browse stopped after ${RATE_BROWSE_MAX_EXECUTION_GENERATIONS} worker attempts`;

  // A hard-deadline exit deliberately leaves the old generation unresolved.
  // Fence that writer and make a repeatedly stale job terminal before admitting
  // more recovery work, so one poisoned request cannot restart the worker forever.
  await pg`
    UPDATE rate_browse_jobs
    SET status = 'error',
        active = false,
        generation = generation + 1,
        message = ${exhaustedMessage},
        snapshot = COALESCE(snapshot, '{}'::jsonb) || jsonb_build_object(
          'phase', 'error',
          'generation', generation + 1,
          'updatedAt', ${nowIso},
          'finishedAt', ${nowIso},
          'message', ${exhaustedMessage},
          'error', ${exhaustedMessage}
        ),
        diagnostics = COALESCE(diagnostics, '{}'::jsonb) || jsonb_build_object(
          'recoveryExhausted', true,
          'executionGenerations', generation
        ),
        snapshot_updated_at = ${nowIso},
        updated_at = ${nowIso},
        finished_at = ${nowIso}
    WHERE active = true
      AND generation >= ${RATE_BROWSE_MAX_EXECUTION_GENERATIONS}
      AND (
        (status = 'queued' AND updated_at < ${staleBefore})
        OR (
          status IN ('running', 'partial')
          AND (heartbeat_at IS NULL OR heartbeat_at < ${staleBefore})
        )
      )
  `;

  const rows = await pg<Array<{ jobId: string }>>`
    SELECT job_id AS "jobId"
    FROM rate_browse_jobs
    WHERE active = true
      AND generation < ${RATE_BROWSE_MAX_EXECUTION_GENERATIONS}
      AND (
        (status = 'queued' AND updated_at < ${staleBefore})
        OR (
          status IN ('running', 'partial')
          AND (heartbeat_at IS NULL OR heartbeat_at < ${staleBefore})
        )
      )
    ORDER BY created_at ASC
    LIMIT ${Math.max(1, Math.min(100, input.limit ?? 25))}
  `;
  return rows.map((row) => row.jobId);
}
