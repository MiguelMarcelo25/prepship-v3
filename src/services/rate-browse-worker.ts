import PgBoss from 'pg-boss';
import { z } from 'zod';
import { env } from '../lib/env';
import { withPgBossPoolLifetime } from '../lib/pg-boss-pool-lifetime';
import { jobSingletonSeconds } from '../lib/job-singleton-seconds';
import { SYNC_JOB_CANCELLATION_GRACE_MS } from '../lib/sync-job-deadline';
import { runDurableWorkerAttempt } from './durable-worker-attempt';
import {
  acknowledgeRateBrowseJobCancellation,
  claimRateBrowseJobRecord,
  heartbeatRateBrowseJobRecord,
  listRecoverableRateBrowseJobIds,
  persistRateBrowseJobRecord,
  requestRateBrowseJobCancellation,
  type RateBrowseJobClaim,
} from './rate-browse-job-store';
import { produceRateBrowsePayload } from './rate-browse-response-producer';
import { buildRateBrowseResultSnapshot } from './rate-browse-workflow-snapshots';
import type { RateBrowseWorkflowSnapshot } from './rate-browse-workflow-types';
import { sanitizeRateProviderError } from './rate-browser-timing-diagnostics';
import {
  recordWorkerJobFailure,
  recordWorkerJobStart,
  recordWorkerJobSuccess,
} from './worker-status';

export const RATE_BROWSE_JOB_NAME = 'prepship.rate-browse.execute';
export const RATE_BROWSE_WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const RATE_BROWSE_WORKER_HEARTBEAT_STALE_MS = 60_000;
export const RATE_BROWSE_WORKER_RECOVERY_INTERVAL_MS = 60_000;
// Interactive rate browse has one consumer slot. Bound it independently from
// the longer sync-job lease so a wedged cached lookup cannot hold every later
// operator request for ten minutes.
export const RATE_BROWSE_WORKER_TIMEOUT_MS = Math.max(
  30_000,
  Math.min(
    5 * 60_000,
    Number(process.env.RATE_BROWSE_WORKER_TIMEOUT_MS) || 60_000,
  ),
);

export function armRateBrowseWorkerHardDeadline(input: {
  jobId: string;
  generation: number;
  timeoutMs?: number;
  graceMs?: number;
  terminate?: () => void;
}): () => void {
  const timeoutMs = input.timeoutMs ?? RATE_BROWSE_WORKER_TIMEOUT_MS;
  const graceMs = input.graceMs ?? SYNC_JOB_CANCELLATION_GRACE_MS;
  // This watchdog is deliberately independent of the work promise and its DB
  // cancellation hooks: Supavisor can leave either promise unsettled.
  const timer = setTimeout(() => {
    console.error(
      `[rate-browse-worker] ${input.jobId} generation ${input.generation} `
        + `ignored cancellation for ${graceMs}ms; terminating worker while the durable generation is fenced`,
    );
    if (input.terminate) input.terminate();
    else process.exit(1);
  }, timeoutMs + graceMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

const payloadSchema = z.object({
  jobId: z.string().uuid(),
  recovery: z.boolean().optional().default(false),
});

const singletonSeconds = jobSingletonSeconds(60_000);
let producerPromise: Promise<PgBoss> | null = null;
let consumer: PgBoss | null = null;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

function createBoss(applicationName: string, consumerRole: boolean): PgBoss {
  return new PgBoss(withPgBossPoolLifetime({
    connectionString: env.DATABASE_URL,
    schema: env.PG_BOSS_SCHEMA,
    application_name: applicationName,
    max: consumerRole ? Math.max(1, Math.min(2, env.PG_BOSS_POOL_MAX)) : 1,
    retryLimit: 2,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    retentionDays: 7,
    deleteAfterDays: 7,
    // Rate browse provider work is durable, but the worker process can be
    // replaced during a deploy. Let pg-boss expire abandoned active claims so
    // they cannot consume the only browse slot after the replacement starts.
    supervise: consumerRole,
    maintenanceIntervalSeconds: 60,
    schedule: false,
    migrate: false,
  }, env.DB_MAX_LIFETIME_SECONDS));
}

async function ensureQueue(target: PgBoss): Promise<void> {
  await target.createQueue(RATE_BROWSE_JOB_NAME, {
    name: RATE_BROWSE_JOB_NAME,
    retryLimit: 2,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    retentionDays: 7,
  });
}

async function producer(): Promise<PgBoss> {
  if (!producerPromise) {
    producerPromise = (async () => {
      const target = createBoss('prepship-api-rate-browse-enqueue', false);
      target.on('error', (error) => {
        console.error('[rate-browse-enqueue] pg-boss error:', error.message);
      });
      await target.start();
      await ensureQueue(target);
      return target;
    })().catch((error) => {
      producerPromise = null;
      throw error;
    });
  }
  return producerPromise;
}

async function sendRateBrowseJob(
  target: PgBoss,
  jobId: string,
  recovery: boolean,
): Promise<string | null> {
  const singletonKey = recovery
    ? `${jobId}:recovery:${Math.floor(Date.now() / RATE_BROWSE_WORKER_RECOVERY_INTERVAL_MS)}`
    : jobId;
  const id = await target.send(
    RATE_BROWSE_JOB_NAME,
    { jobId, recovery },
    {
      singletonKey,
      singletonSeconds,
      retryLimit: 2,
      retryDelay: 15,
      retryBackoff: true,
      expireInMinutes: 30,
      retentionDays: 7,
    },
  );
  return id ? String(id) : null;
}

export async function enqueueRateBrowseWorkerJob(
  jobId: string,
  options: { recovery?: boolean } = {},
): Promise<{ queued: boolean; pgBossJobId: string | null; error: string | null }> {
  try {
    const pgBossJobId = await sendRateBrowseJob(await producer(), jobId, options.recovery === true);
    return { queued: Boolean(pgBossJobId), pgBossJobId, error: null };
  } catch (error) {
    return {
      queued: false,
      pgBossJobId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function cachedPreviewBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    cachedOnly: true,
    forceLive: false,
    forceRefresh: false,
    strictRecalculate: false,
    manualEstimate: false,
  };
}

async function persistCurrent(
  snapshot: RateBrowseWorkflowSnapshot,
  claim: RateBrowseJobClaim,
): Promise<void> {
  const persisted = await persistRateBrowseJobRecord(snapshot, { priority: claim.input.priority });
  if (!persisted) throw new Error(`Rate browse generation ${claim.generation} is stale`);
}

async function executeClaimWithinFence(claim: RateBrowseJobClaim): Promise<Record<string, unknown>> {
  const running: RateBrowseWorkflowSnapshot = {
    ...claim.snapshot,
    generation: claim.generation,
    phase: 'running',
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    message: 'Rate browse workflow running in durable worker',
  };
  await persistCurrent(running, claim);

  const attempt = await runDurableWorkerAttempt({
    label: `${RATE_BROWSE_JOB_NAME}:${running.jobId}:${claim.generation}`,
    timeoutMs: RATE_BROWSE_WORKER_TIMEOUT_MS,
    heartbeatIntervalMs: RATE_BROWSE_WORKER_HEARTBEAT_INTERVAL_MS,
    hooks: {
      heartbeat: () => heartbeatRateBrowseJobRecord(running.jobId, claim.generation),
      requestCancellation: () => requestRateBrowseJobCancellation(running.jobId, claim.generation),
      acknowledgeCancellation: () => acknowledgeRateBrowseJobCancellation(running.jobId, claim.generation),
    },
    execute: async (signal) => {
      if (claim.input.includeCachedPartial) {
        try {
          const partial = await produceRateBrowsePayload({
            body: cachedPreviewBody(claim.input.body),
            canViewFinancials: claim.input.canViewFinancials,
            browseStartedAt: Date.now(),
            signal,
          });
          if (Array.isArray(partial.rates) && partial.rates.length > 0) {
            await persistCurrent(buildRateBrowseResultSnapshot({
              base: running,
              result: partial,
              phase: 'partial',
              message: 'Cached rates available while live carriers continue',
              finishedAt: null,
              diagnostics: { partialSource: 'cache-first' },
            }), claim);
          }
        } catch (error) {
          await persistCurrent({
            ...running,
            updatedAt: new Date().toISOString(),
            message: 'Rate browse workflow running; cached partial unavailable',
            diagnostics: {
              ...running.diagnostics,
              partialError: sanitizeRateProviderError(error),
            },
          }, claim);
        }
      }
      return produceRateBrowsePayload({
        body: claim.input.body,
        canViewFinancials: claim.input.canViewFinancials,
        browseStartedAt: Date.now(),
        signal,
      });
    },
  });

  const finishedAt = new Date().toISOString();
  await persistCurrent(buildRateBrowseResultSnapshot({
    base: running,
    result: attempt.value,
    phase: 'complete',
    message: attempt.timedOut
      ? 'Rate browse workflow completed after cancellation was requested'
      : 'Rate browse workflow complete',
    finishedAt,
    diagnostics: {
      rateBrowseTiming: attempt.value.rateBrowseTiming ?? null,
      rateBrowseFailure: attempt.value.rateBrowseFailure ?? null,
      cancellationAcknowledged: attempt.timedOut,
    },
  }), claim);
  return attempt.value;
}

async function executeClaim(claim: RateBrowseJobClaim): Promise<Record<string, unknown>> {
  const disarmHardDeadline = armRateBrowseWorkerHardDeadline({
    jobId: claim.snapshot.jobId,
    generation: claim.generation,
  });
  try {
    return await executeClaimWithinFence(claim);
  } finally {
    disarmHardDeadline();
  }
}

async function recoverRateBrowseJobs(target: PgBoss): Promise<number> {
  const ids = await listRecoverableRateBrowseJobIds({
    staleAfterMs: RATE_BROWSE_WORKER_HEARTBEAT_STALE_MS,
    limit: 25,
  });
  let queued = 0;
  for (const jobId of ids) {
    if (await sendRateBrowseJob(target, jobId, true)) queued += 1;
  }
  return queued;
}

export async function startRateBrowseWorker(): Promise<void> {
  if (started) return;
  consumer = createBoss('prepship-worker-rate-browse', true);
  consumer.on('error', (error) => {
    console.error('[rate-browse-worker] pg-boss error:', error.message);
  });
  await consumer.start();
  await ensureQueue(consumer);
  await consumer.work(
    RATE_BROWSE_JOB_NAME,
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      const payload = payloadSchema.parse(job?.data);
      const startedAt = Date.now();
      await recordWorkerJobStart(RATE_BROWSE_JOB_NAME);
      const claim = await claimRateBrowseJobRecord(payload.jobId, {
        staleAfterMs: RATE_BROWSE_WORKER_HEARTBEAT_STALE_MS,
      });
      if (!claim) {
        const result = { skipped: true, reason: 'active_generation_exists_or_job_terminal' };
        await recordWorkerJobSuccess(RATE_BROWSE_JOB_NAME, startedAt, result);
        return result;
      }
      try {
        const result = await executeClaim(claim);
        await recordWorkerJobSuccess(RATE_BROWSE_JOB_NAME, startedAt, result);
        return { ok: true, jobId: claim.snapshot.jobId, generation: claim.generation };
      } catch (error) {
        const finishedAt = new Date().toISOString();
        await persistRateBrowseJobRecord({
          ...claim.snapshot,
          generation: claim.generation,
          phase: 'error',
          updatedAt: finishedAt,
          finishedAt,
          message: 'Rate browse workflow failed',
          error: sanitizeRateProviderError(error),
        }, { priority: claim.input.priority }).catch(() => false);
        await recordWorkerJobFailure(RATE_BROWSE_JOB_NAME, startedAt, error).catch(() => undefined);
        throw error;
      }
    },
  );
  await recoverRateBrowseJobs(consumer);
  recoveryTimer = setInterval(() => {
    if (consumer) void recoverRateBrowseJobs(consumer).catch((error) => {
      console.error('[rate-browse-worker] recovery failed:', error instanceof Error ? error.message : error);
    });
  }, RATE_BROWSE_WORKER_RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();
  started = true;
  console.log('[rate-browse-worker] started');
}

export async function stopRateBrowseWorker(): Promise<void> {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
  if (consumer) {
    await consumer.stop({ graceful: true, timeout: 30_000 });
    consumer = null;
  }
  started = false;
}
