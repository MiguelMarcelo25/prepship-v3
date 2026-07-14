import PgBoss from 'pg-boss';
import { z } from 'zod';
import { env } from '../lib/env';
import { jobSingletonSeconds } from '../lib/job-singleton-seconds';
import { DeadlineExceededError, withDeadline } from '../lib/with-deadline';
import type { PrintQueueListScope, QueueSendOrderInput } from './print-queue';
import {
  claimRecoverableQueueSendJobRecords,
  getQueueSendJobRecord,
  interruptExhaustedQueueSendJobs,
  markQueueSendJobInterrupted,
  persistQueueSendJobRecord,
} from './print-queue/queue-send-job-store';
import { QUEUE_SEND_DURABLE_STALE_AFTER_MS } from './print-queue/queue-send-status';
import {
  planQueueSendWorkerChunks,
  QUEUE_SEND_EXECUTION_CHUNK_SIZE,
} from './print-queue/queue-send-execution';

export { planQueueSendWorkerChunks } from './print-queue/queue-send-execution';

export const PRINT_QUEUE_SEND_JOB_NAME = 'prepship.print-queue.batch-send';
const PRINT_QUEUE_SEND_SINGLETON_SECONDS = jobSingletonSeconds(24 * 60 * 60 * 1000);
export const PRINT_QUEUE_SEND_CHUNK_SIZE = QUEUE_SEND_EXECUTION_CHUNK_SIZE;
export const PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS = 3;
export const PRINT_QUEUE_SEND_RECOVERY_INTERVAL_MS = 60_000;

const scopeSchema = z.object({
  scopeClientIds: z.array(z.number().int().positive()).optional(),
  scopeStoreIds: z.array(z.number().int().positive()).optional(),
  scopeRestricted: z.boolean().optional(),
}).optional();

const payloadSchema = z.object({
  jobId: z.string().min(1),
  orders: z.array(z.unknown()).min(1).max(PRINT_QUEUE_SEND_CHUNK_SIZE),
  concurrency: z.number().int().min(1).max(4).optional(),
  scope: scopeSchema,
  requestedAt: z.string().optional(),
  chunkSequence: z.number().int().positive().default(1),
  recoveryAttempt: z.number().int().nonnegative().default(0),
});

export type QueueSendWorkerPayload = {
  jobId: string;
  orders: QueueSendOrderInput[];
  concurrency?: number;
  scope?: PrintQueueListScope;
  requestedAt?: string;
  chunkSequence?: number;
  recoveryAttempt?: number;
};

export type QueueSendWorkerEnqueueResult = {
  queued: boolean;
  pgBossJobId: string | null;
  error: string | null;
};

export type QueueSendWorkerRecoveryResult = {
  scanned: number;
  requeued: number;
  interrupted: number;
};

let boss: PgBoss | null = null;
let enqueueBossPromise: Promise<PgBoss> | null = null;
let started = false;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let recoveryPass: Promise<QueueSendWorkerRecoveryResult> | null = null;

function createPrintQueueBoss(applicationName: string, max = 1): PgBoss {
  return new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: env.PG_BOSS_SCHEMA,
    application_name: applicationName,
    max,
    retryLimit: 1,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    retentionDays: 7,
    deleteAfterDays: 7,
    supervise: true,
    maintenanceIntervalSeconds: 60,
  });
}

async function ensurePrintQueueSendQueue(targetBoss: PgBoss): Promise<void> {
  await targetBoss.createQueue(PRINT_QUEUE_SEND_JOB_NAME, {
    name: PRINT_QUEUE_SEND_JOB_NAME,
    retryLimit: 1,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    retentionDays: 7,
  });
}

async function getPrintQueueEnqueueBoss(): Promise<PgBoss> {
  if (!enqueueBossPromise) {
    enqueueBossPromise = (async () => {
      const targetBoss = createPrintQueueBoss('prepship-api-print-queue-enqueue', 1);
      targetBoss.on('error', (err) => {
        console.error('[print-queue-enqueue] pg-boss error:', err.message);
      });
      try {
        await targetBoss.start();
        await ensurePrintQueueSendQueue(targetBoss);
        return targetBoss;
      } catch (error) {
        await targetBoss.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
        throw error;
      }
    })().catch((error) => {
      enqueueBossPromise = null;
      throw error;
    });
  }
  return enqueueBossPromise;
}

function recoverableOrders(value: unknown): QueueSendOrderInput[] {
  return Array.isArray(value) ? (value as QueueSendOrderInput[]) : [];
}

function parseQueueSendWorkerPayload(value: unknown): QueueSendWorkerPayload {
  const parsed = payloadSchema.parse(value);
  return {
    jobId: parsed.jobId,
    orders: parsed.orders as QueueSendOrderInput[],
    concurrency: parsed.concurrency,
    scope: parsed.scope,
    requestedAt: parsed.requestedAt,
    chunkSequence: parsed.chunkSequence,
    recoveryAttempt: parsed.recoveryAttempt,
  };
}

function queueSendChunkSingletonKey(payload: QueueSendWorkerPayload): string {
  return [
    payload.jobId,
    `recovery-${payload.recoveryAttempt ?? 0}`,
    `chunk-${payload.chunkSequence ?? 1}`,
  ].join(':');
}

async function sendQueueSendChunk(
  targetBoss: PgBoss,
  payload: QueueSendWorkerPayload,
): Promise<string | null> {
  const pgBossJobId = await targetBoss.send(
    PRINT_QUEUE_SEND_JOB_NAME,
    {
      ...payload,
      requestedAt: payload.requestedAt ?? new Date().toISOString(),
      chunkSequence: payload.chunkSequence ?? 1,
      recoveryAttempt: payload.recoveryAttempt ?? 0,
    },
    {
      singletonKey: queueSendChunkSingletonKey(payload),
      singletonSeconds: PRINT_QUEUE_SEND_SINGLETON_SECONDS,
      retryLimit: 1,
      retryDelay: 30,
      retryBackoff: true,
      expireInMinutes: 30,
      retentionDays: 7,
    },
  );
  return pgBossJobId ? String(pgBossJobId) : null;
}

export async function enqueueQueueSendWorkerJob(
  payload: QueueSendWorkerPayload,
): Promise<QueueSendWorkerEnqueueResult> {
  try {
    // Per user override unlock shipped data on 2026-07-14 (Audit PQ-10):
    // API enqueues share one supervised pg-boss instance; this schedules only
    // orchestration metadata and never calls a label provider.
    const targetBoss = await getPrintQueueEnqueueBoss();
    // Per user override unlock shipped data on 2026-07-14: enqueue only the
    // first bounded chunk. Each successful chunk schedules the next one; label
    // purchase safety remains in createLabelV2 and no provider call happens here.
    const firstChunk = planQueueSendWorkerChunks(payload.orders)[0] ?? [];
    const pgBossJobId = firstChunk.length > 0
      ? await sendQueueSendChunk(targetBoss, {
          ...payload,
          orders: firstChunk,
          chunkSequence: 1,
          recoveryAttempt: 0,
        })
      : null;
    return {
      queued: Boolean(pgBossJobId),
      pgBossJobId: pgBossJobId ? String(pgBossJobId) : null,
      error: null,
    };
  } catch (err) {
    return {
      queued: false,
      pgBossJobId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function markRecoverableJobInterrupted(
  snapshot: Awaited<ReturnType<typeof claimRecoverableQueueSendJobRecords>>[number],
): Promise<void> {
  await markQueueSendJobInterrupted(
    snapshot.jobId,
    'Queue job interrupted before a durable worker payload was available; verify the queue and retry.',
  );
}

async function recoverStaleQueueSendJobs(targetBoss: PgBoss): Promise<QueueSendWorkerRecoveryResult> {
  const exhausted = await interruptExhaustedQueueSendJobs({
    staleAfterMs: QUEUE_SEND_DURABLE_STALE_AFTER_MS,
    maxAttempts: PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS,
  });
  const snapshots = await claimRecoverableQueueSendJobRecords({
    staleAfterMs: QUEUE_SEND_DURABLE_STALE_AFTER_MS,
    maxAttempts: PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS,
    limit: 25,
  });
  let requeued = 0;
  let interrupted = exhausted;

  for (const snapshot of snapshots) {
    const orders = recoverableOrders(snapshot.workerOrders);
    if (!orders.length) {
      await markRecoverableJobInterrupted(snapshot);
      interrupted += 1;
      continue;
    }
    const completedOrderIds = new Set(
      (snapshot.results ?? []).map((result) => result.orderId),
    );
    const remainingOrders = orders.filter((order) => !completedOrderIds.has(order.orderId));
    if (!remainingOrders.length) {
      const now = new Date().toISOString();
      await persistQueueSendJobRecord({
        ...snapshot,
        status: 'done',
        active: false,
        current: snapshot.total,
        progress: 100,
        message:
          `Queued ${snapshot.queued}/${snapshot.total}` +
          `${snapshot.skipped ? `, ${snapshot.skipped} skipped` : ''}` +
          `${snapshot.failed ? `, ${snapshot.failed} failed` : ''}`,
        updatedAt: now,
        persistedAt: now,
      });
      continue;
    }

    const recoveryAttempt = Math.max(1, Math.floor(snapshot.recoveryAttempts ?? 1));
    try {
      const pgBossJobId = await sendQueueSendChunk(targetBoss, {
        jobId: snapshot.jobId,
        orders: remainingOrders.slice(0, PRINT_QUEUE_SEND_CHUNK_SIZE),
        concurrency: snapshot.workerConcurrency ?? undefined,
        scope: snapshot.workerScope ?? {},
        requestedAt: new Date().toISOString(),
        chunkSequence: 1,
        recoveryAttempt,
      });
      if (pgBossJobId) {
        const now = new Date().toISOString();
        await persistQueueSendJobRecord({
          ...snapshot,
          status: 'pending',
          active: true,
          message:
            `Recovery attempt ${recoveryAttempt}/${PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS} ` +
            `queued for ${Math.min(remainingOrders.length, PRINT_QUEUE_SEND_CHUNK_SIZE)} remaining orders`,
          updatedAt: now,
          persistedAt: now,
        });
        requeued += 1;
      } else {
        // Audit PQ-2: a singleton dedupe must never leave the durable snapshot
        // looking active. Persist interruption so the next bounded reaper pass
        // can retry with a new durable attempt number.
        await markQueueSendJobInterrupted(
          snapshot.jobId,
          `Recovery attempt ${recoveryAttempt}/${PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS} was deduplicated; verify the queue before retrying.`,
        );
        interrupted += 1;
      }
    } catch (err) {
      await markQueueSendJobInterrupted(
        snapshot.jobId,
        `Recovery attempt ${recoveryAttempt}/${PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS} could not be queued: ${err instanceof Error ? err.message : String(err)}`,
      );
      interrupted += 1;
    }
  }

  return { scanned: snapshots.length, requeued, interrupted };
}

async function runRecoveryPass(targetBoss: PgBoss): Promise<QueueSendWorkerRecoveryResult> {
  if (recoveryPass) return recoveryPass;
  recoveryPass = recoverStaleQueueSendJobs(targetBoss).finally(() => {
    recoveryPass = null;
  });
  return recoveryPass;
}

function startPeriodicRecovery(targetBoss: PgBoss): void {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = setInterval(() => {
    void runRecoveryPass(targetBoss)
      .then((recovery) => {
        if (recovery.scanned > 0 || recovery.interrupted > 0) {
          console.log(
            `[print-queue-worker] recovery scanned=${recovery.scanned} requeued=${recovery.requeued} interrupted=${recovery.interrupted}`,
          );
        }
      })
      .catch((err) => {
        console.error(
          '[print-queue-worker] periodic recovery failed:',
          err instanceof Error ? err.message : err,
        );
      });
  }, PRINT_QUEUE_SEND_RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();
}

async function enqueueNextQueueSendChunk(
  targetBoss: PgBoss,
  payload: QueueSendWorkerPayload,
): Promise<void> {
  const snapshot = await getQueueSendJobRecord(payload.jobId);
  if (!snapshot || snapshot.status === 'done' || snapshot.status === 'error') return;
  const completedOrderIds = new Set(
    (snapshot.results ?? []).map((result) => result.orderId),
  );
  const remainingOrders = recoverableOrders(snapshot.workerOrders)
    .filter((order) => !completedOrderIds.has(order.orderId));
  if (!remainingOrders.length) return;

  const nextPayload: QueueSendWorkerPayload = {
    jobId: snapshot.jobId,
    orders: remainingOrders.slice(0, PRINT_QUEUE_SEND_CHUNK_SIZE),
    concurrency: snapshot.workerConcurrency ?? undefined,
    scope: snapshot.workerScope ?? {},
    requestedAt: new Date().toISOString(),
    chunkSequence: (payload.chunkSequence ?? 1) + 1,
    recoveryAttempt: payload.recoveryAttempt ?? snapshot.recoveryAttempts ?? 0,
  };
  const pgBossJobId = await sendQueueSendChunk(targetBoss, nextPayload);
  if (!pgBossJobId) {
    console.info(
      `[print-queue-worker] continuation deduped jobId=${payload.jobId} ` +
      `chunk=${nextPayload.chunkSequence}`,
    );
  }
}

export async function startPrintQueueWorker(): Promise<void> {
  if (started) {
    console.warn('[print-queue-worker] already started, ignoring duplicate start');
    return;
  }
  started = true;

  boss = createPrintQueueBoss('prepship-print-worker', env.PG_BOSS_POOL_MAX);
  boss.on('error', (err) => {
    console.error('[print-queue-worker] pg-boss error:', err.message);
  });

  try {
    await boss.start();
    await ensurePrintQueueSendQueue(boss);
    const recovery = await runRecoveryPass(boss);
    if (recovery.scanned > 0) {
      console.log(
        `[print-queue-worker] recovery scanned=${recovery.scanned} requeued=${recovery.requeued} interrupted=${recovery.interrupted}`,
      );
    }
    await boss.work(
      PRINT_QUEUE_SEND_JOB_NAME,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]) => {
        const payload = parseQueueSendWorkerPayload(job?.data);
        console.log(
          `[print-queue-worker] started ${payload.jobId} ` +
          `chunk=${payload.chunkSequence} recovery=${payload.recoveryAttempt} (${job?.id ?? 'unknown'})`,
        );
        const startedAt = Date.now();
        const abortController = new AbortController();
        try {
          const { runQueueSendJobFromWorker } = await import('./print-queue');
          const result = await withDeadline(
            () => runQueueSendJobFromWorker(payload, { signal: abortController.signal }),
            env.PRINT_QUEUE_WORKER_JOB_TIMEOUT_MS,
            `${PRINT_QUEUE_SEND_JOB_NAME}:${payload.jobId}`,
            {
              // Audit PQ-1: stop admitting new orders. In-flight label work is
              // allowed to settle through its idempotent purchase boundary.
              onTimeout: () => abortController.abort(),
            },
          );
          await enqueueNextQueueSendChunk(boss!, payload);
          console.log(
            `[print-queue-worker] completed ${payload.jobId} chunk=${payload.chunkSequence} ` +
            `in ${Date.now() - startedAt}ms`,
          );
          return result;
        } catch (err) {
          if (err instanceof DeadlineExceededError) {
            // Per user override unlock shipped data on 2026-07-14: timeout
            // persistence changes durable queue metadata only. It does not
            // cancel/repurchase postage or mutate shipped order history.
            await markQueueSendJobInterrupted(
              payload.jobId,
              `Queue chunk ${payload.chunkSequence} timed out after ${env.PRINT_QUEUE_WORKER_JOB_TIMEOUT_MS}ms ` +
              `(recovery ${payload.recoveryAttempt}/${PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS}); no new orders will be admitted.`,
            ).catch(() => undefined);
          }
          console.error(
            `[print-queue-worker] failed ${payload.jobId} after ${Date.now() - startedAt}ms:`,
            err instanceof Error ? err.message : err,
          );
          throw err;
        }
      },
    );
    startPeriodicRecovery(boss);
    console.log('[print-queue-worker] started');
  } catch (err) {
    started = false;
    const targetBoss = boss;
    boss = null;
    await targetBoss?.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
    throw err;
  }
}

export async function stopPrintQueueWorker(): Promise<void> {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30_000 });
    boss = null;
  }
  if (started) {
    console.log('[print-queue-worker] stopped');
  }
  started = false;
}
