import PgBoss from 'pg-boss';
import { z } from 'zod';
import { env } from '../lib/env';
import { jobSingletonSeconds } from '../lib/job-singleton-seconds';
import { PRINT_QUEUE_WORKER_HANDLER_TIMEOUT_MS } from '../lib/print-queue-worker-deadline';
import { DeadlineExceededError, withDeadline } from '../lib/with-deadline';
import type { PrintQueueListScope, QueueSendOrderInput } from './print-queue';
import { runDurableWorkerAttempt } from './durable-worker-attempt';
import {
  acknowledgePrintMergeJobCancellation,
  claimPrintMergeJobRecord,
  heartbeatPrintMergeJobRecord,
  listRecoverablePrintMergeJobIds,
  requestPrintMergeJobCancellation,
} from './print-queue/merge-job-store';
import {
  claimRecoverableQueueSendJobRecords,
  getQueueSendJobRecord,
  interruptExhaustedQueueSendJobs,
  markQueueSendJobWorkerClaimed,
  markQueueSendJobInterrupted,
  persistQueueSendJobRecord,
  readQueueSendJobRecoverySafety,
} from './print-queue/queue-send-job-store';
import { QUEUE_SEND_DURABLE_STALE_AFTER_MS } from './print-queue/queue-send-status';
import {
  planQueueSendWorkerChunks,
  QUEUE_SEND_EXECUTION_CHUNK_SIZE,
} from './print-queue/queue-send-execution';
import {
  canAutomaticallyRecoverQueueSendJob,
  classifyPrintQueueWorkerFatalError,
  createPrintQueueWorkerFatalSignalState,
  evaluateQueueSendWorkerAdmission,
  PRINT_QUEUE_SEND_JOB_NAME,
  recordPrintQueueWorkerFatalSignal,
  resolvePrintQueueWorkerDatabaseUrl,
  type PrintQueueWorkerFatalSignal,
} from './print-queue-worker-policy';
import { readPrintQueueWorkerHealth } from './print-queue-worker-health';
import {
  recordWorkerJobFailure,
  recordWorkerJobStart,
  recordWorkerJobSuccess,
} from './worker-status';

export { planQueueSendWorkerChunks } from './print-queue/queue-send-execution';

export { PRINT_QUEUE_SEND_JOB_NAME } from './print-queue-worker-policy';
const PRINT_QUEUE_SEND_SINGLETON_SECONDS = jobSingletonSeconds(24 * 60 * 60 * 1000);
export const PRINT_QUEUE_SEND_CHUNK_SIZE = QUEUE_SEND_EXECUTION_CHUNK_SIZE;
export const PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS = 3;
export const PRINT_QUEUE_SEND_RECOVERY_INTERVAL_MS = 60_000;
export const PRINT_QUEUE_MERGE_JOB_NAME = 'prepship.print-queue.merge';
export const PRINT_QUEUE_MERGE_HEARTBEAT_INTERVAL_MS = 15_000;
export const PRINT_QUEUE_MERGE_HEARTBEAT_STALE_MS = 60_000;

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

const mergePayloadSchema = z.object({
  jobId: z.string().uuid(),
  recovery: z.boolean().optional().default(false),
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
let healthTimer: ReturnType<typeof setInterval> | null = null;
let recoveryPass: Promise<QueueSendWorkerRecoveryResult> | null = null;
let mergeRecoveryPass: Promise<number> | null = null;
let fatalRestartRequested = false;
let fatalSignalState = createPrintQueueWorkerFatalSignalState();
let warningListener: ((warning: Error) => void) | null = null;

type PrintQueueBossRole = 'producer' | 'consumer';

type PgBossPoolSafetyOptions = PgBoss.ConstructorOptions & {
  statement_timeout: number;
  idle_in_transaction_session_timeout: number;
  idleTimeoutMillis: number;
  maxLifetimeSeconds: number;
};

function createPrintQueueBoss(
  applicationName: string,
  max = 1,
  role: PrintQueueBossRole = 'producer',
): PgBoss {
  const consumer = role === 'consumer';
  const connectionString = consumer
    ? resolvePrintQueueWorkerDatabaseUrl({
        databaseUrl: env.DATABASE_URL,
        dedicatedDatabaseUrl: env.PRINT_QUEUE_PG_BOSS_DATABASE_URL,
        nodeEnv: env.NODE_ENV,
        runWorker: env.RUN_PRINT_QUEUE_WORKER,
      })
    : env.DATABASE_URL;
  const options: PgBossPoolSafetyOptions = {
    connectionString,
    schema: env.PG_BOSS_SCHEMA,
    application_name: applicationName,
    max,
    // Per user override unlock shipped data on 2026-07-15: PS-430 bounds
    // pg-boss claim transactions at the connection boundary. These settings
    // cannot buy postage or change shipped/cancelled records.
    statement_timeout: env.PRINT_QUEUE_PG_BOSS_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout:
      env.PRINT_QUEUE_PG_BOSS_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 15 * 60,
    retryLimit: 1,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    retentionDays: 7,
    deleteAfterDays: 7,
    supervise: consumer,
    schedule: consumer,
    migrate: consumer,
    clockMonitorIntervalSeconds: 60,
    maintenanceIntervalSeconds: 60,
  };
  return new PgBoss(options);
}

async function ensurePrintQueueQueues(targetBoss: PgBoss): Promise<void> {
  await Promise.all([
    targetBoss.createQueue(PRINT_QUEUE_SEND_JOB_NAME, {
      name: PRINT_QUEUE_SEND_JOB_NAME,
      retryLimit: 1,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 30 * 60,
      retentionDays: 7,
    }),
    targetBoss.createQueue(PRINT_QUEUE_MERGE_JOB_NAME, {
      name: PRINT_QUEUE_MERGE_JOB_NAME,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 30 * 60,
      retentionDays: 7,
    }),
  ]);
}

async function getPrintQueueEnqueueBoss(): Promise<PgBoss> {
  if (!enqueueBossPromise) {
    enqueueBossPromise = (async () => {
      // Producer-only pg-boss never runs maintenance, scheduling, or a claim
      // loop on the API's transaction-pooler connection.
      const targetBoss = createPrintQueueBoss('prepship-api-print-queue-enqueue', 1, 'producer');
      targetBoss.on('error', (err) => {
        console.error('[print-queue-enqueue] pg-boss error:', err.message);
      });
      try {
        await targetBoss.start();
        await ensurePrintQueueQueues(targetBoss);
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

async function sendPrintMergeJob(
  targetBoss: PgBoss,
  jobId: string,
  recovery: boolean,
): Promise<string | null> {
  const singletonKey = recovery
    ? `${jobId}:recovery:${Math.floor(Date.now() / PRINT_QUEUE_SEND_RECOVERY_INTERVAL_MS)}`
    : jobId;
  const pgBossJobId = await targetBoss.send(
    PRINT_QUEUE_MERGE_JOB_NAME,
    { jobId, recovery },
    {
      singletonKey,
      singletonSeconds: jobSingletonSeconds(PRINT_QUEUE_SEND_RECOVERY_INTERVAL_MS),
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInMinutes: 30,
      retentionDays: 7,
    },
  );
  return pgBossJobId ? String(pgBossJobId) : null;
}

export async function enqueuePrintMergeWorkerJob(
  jobId: string,
  options: { recovery?: boolean } = {},
): Promise<QueueSendWorkerEnqueueResult> {
  try {
    const pgBossJobId = await sendPrintMergeJob(
      await getPrintQueueEnqueueBoss(),
      jobId,
      options.recovery === true,
    );
    return { queued: Boolean(pgBossJobId), pgBossJobId, error: null };
  } catch (error) {
    return {
      queued: false,
      pgBossJobId: null,
      error: error instanceof Error ? error.message : String(error),
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
    let recoverySafety: Awaited<ReturnType<typeof readQueueSendJobRecoverySafety>>;
    try {
      recoverySafety = await readQueueSendJobRecoverySafety(snapshot.jobId);
    } catch (err) {
      await markQueueSendJobInterrupted(
        snapshot.jobId,
        'Recovery safety state could not be read; verify the durable item records before retrying.',
      ).catch(() => undefined);
      console.error(
        `[print-queue-worker] recovery safety read failed jobId=${snapshot.jobId}:`,
        err instanceof Error ? err.message : err,
      );
      interrupted += 1;
      continue;
    }
    if (!canAutomaticallyRecoverQueueSendJob(recoverySafety.providerPendingCount)) {
      // Per user override unlock shipped data on 2026-07-15: PS-430 blocks
      // automatic recovery while a provider outcome is unknown. The durable
      // metadata is interrupted; no provider call, label repurchase, or order
      // mutation is performed here.
      await markQueueSendJobInterrupted(
        snapshot.jobId,
        `Recovery blocked: ${recoverySafety.providerPendingCount} provider outcome(s) require reconciliation before retrying.`,
      );
      interrupted += 1;
      continue;
    }
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

async function recoverStalePrintMergeJobs(targetBoss: PgBoss): Promise<number> {
  if (mergeRecoveryPass) return mergeRecoveryPass;
  mergeRecoveryPass = (async () => {
    const jobIds = await listRecoverablePrintMergeJobIds({
      staleAfterMs: PRINT_QUEUE_MERGE_HEARTBEAT_STALE_MS,
      limit: 25,
    });
    let requeued = 0;
    for (const jobId of jobIds) {
      if (await sendPrintMergeJob(targetBoss, jobId, true)) requeued += 1;
    }
    return requeued;
  })().finally(() => {
    mergeRecoveryPass = null;
  });
  return mergeRecoveryPass;
}

function startPeriodicRecovery(targetBoss: PgBoss): void {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = setInterval(() => {
    void Promise.all([runRecoveryPass(targetBoss), recoverStalePrintMergeJobs(targetBoss)])
      .then(([recovery, mergeRequeued]) => {
        if (recovery.scanned > 0 || recovery.interrupted > 0) {
          console.log(
            `[print-queue-worker] recovery scanned=${recovery.scanned} requeued=${recovery.requeued} interrupted=${recovery.interrupted}`,
          );
        }
        if (mergeRequeued > 0) {
          console.log(`[print-queue-worker] merge recovery requeued=${mergeRequeued}`);
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

function noteFatalSignal(signal: PrintQueueWorkerFatalSignal): void {
  const recorded = recordPrintQueueWorkerFatalSignal(fatalSignalState, signal);
  fatalSignalState = recorded.state;
  if (recorded.fatal) requestFatalWorkerRestart(`repeated_${signal}`);
}

function requestFatalWorkerRestart(reason: string): void {
  if (fatalRestartRequested) return;
  fatalRestartRequested = true;
  process.exitCode = 1;
  console.error(`[print-queue-worker] unhealthy; requesting supervisor restart (${reason})`);
  void (async () => {
    const forceExit = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20_000);
      timer.unref?.();
    });
    await Promise.race([
      stopPrintQueueWorker().catch(() => undefined),
      forceExit,
    ]);
    process.exit(1);
  })();
}

function startWorkerHealthMonitor(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    void readPrintQueueWorkerHealth()
      .then((health) => {
        if (health.status === 'fail') {
          console.error(
            `[print-queue-worker] health degraded reasons=${health.reasons.join(',') || 'unknown'} ` +
            `pgboss=${health.facts.pgBossCreated + health.facts.pgBossRetry}/${health.facts.pgBossActive} ` +
            `durable=${health.facts.durableCurrent}/${health.facts.durableTotal}`,
          );
        }
        if (health.restartRequired) {
          requestFatalWorkerRestart(health.reasons.join(',') || 'health_failed');
        }
      })
      .catch(() => requestFatalWorkerRestart('health_probe_failed'));
  }, env.PRINT_QUEUE_WORKER_HEALTH_INTERVAL_MS);
  healthTimer.unref?.();
}

function installPgBossWarningListener(): void {
  if (warningListener) return;
  warningListener = (warning: Error) => {
    const code = (warning as Error & { code?: string }).code;
    if (code === 'pg-boss-w02') noteFatalSignal('timekeeper_skew');
  };
  process.on('warning', warningListener);
}

function removePgBossWarningListener(): void {
  if (!warningListener) return;
  process.off('warning', warningListener);
  warningListener = null;
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
  fatalRestartRequested = false;
  fatalSignalState = createPrintQueueWorkerFatalSignalState();
  installPgBossWarningListener();

  boss = createPrintQueueBoss('prepship-print-worker', env.PG_BOSS_POOL_MAX, 'consumer');
  boss.on('error', (err) => {
    console.error('[print-queue-worker] pg-boss error:', err.message);
    const signal = classifyPrintQueueWorkerFatalError(err);
    if (signal) noteFatalSignal(signal);
  });

  try {
    await boss.start();
    await ensurePrintQueueQueues(boss);
    const recovery = await runRecoveryPass(boss);
    const mergeRecovery = await recoverStalePrintMergeJobs(boss);
    if (recovery.scanned > 0) {
      console.log(
        `[print-queue-worker] recovery scanned=${recovery.scanned} requeued=${recovery.requeued} interrupted=${recovery.interrupted}`,
      );
    }
    if (mergeRecovery > 0) {
      console.log(`[print-queue-worker] merge recovery requeued=${mergeRecovery}`);
    }
    await boss.work(
      PRINT_QUEUE_MERGE_JOB_NAME,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]) => {
        const payload = mergePayloadSchema.parse(job?.data);
        const workerStatusStartedAt = Date.now();
        await recordWorkerJobStart(PRINT_QUEUE_MERGE_JOB_NAME);
        const claim = await claimPrintMergeJobRecord(payload.jobId, {
          staleAfterMs: PRINT_QUEUE_MERGE_HEARTBEAT_STALE_MS,
        });
        if (!claim) {
          const result = { skipped: true, reason: 'active_generation_exists_or_job_terminal' };
          await recordWorkerJobSuccess(PRINT_QUEUE_MERGE_JOB_NAME, workerStatusStartedAt, result);
          return result;
        }
        try {
          // Per user override unlock shipped data on 2026-07-15: PS-428 executes only
          // an already-requested merge. Generation fences prevent an expired worker
          // from publishing over its successor; no label purchase or order mutation occurs.
          const { runPrintMergeJobFromWorker } = await import('./print-queue');
          const attempt = await runDurableWorkerAttempt({
            label: `${PRINT_QUEUE_MERGE_JOB_NAME}:${payload.jobId}:${claim.generation}`,
            timeoutMs: PRINT_QUEUE_WORKER_HANDLER_TIMEOUT_MS,
            heartbeatIntervalMs: PRINT_QUEUE_MERGE_HEARTBEAT_INTERVAL_MS,
            hooks: {
              heartbeat: () => heartbeatPrintMergeJobRecord(payload.jobId, claim.generation),
              requestCancellation: () => requestPrintMergeJobCancellation(payload.jobId, claim.generation),
              acknowledgeCancellation: () => acknowledgePrintMergeJobCancellation(payload.jobId, claim.generation),
            },
            execute: (signal) => runPrintMergeJobFromWorker(claim, { signal }),
          });
          const result = { ...attempt.value, cancellationAcknowledged: attempt.timedOut };
          await recordWorkerJobSuccess(PRINT_QUEUE_MERGE_JOB_NAME, workerStatusStartedAt, result);
          return result;
        } catch (error) {
          await recordWorkerJobFailure(
            PRINT_QUEUE_MERGE_JOB_NAME,
            workerStatusStartedAt,
            error,
          ).catch(() => undefined);
          throw error;
        }
      },
    );
    await boss.work(
      PRINT_QUEUE_SEND_JOB_NAME,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]) => {
        const payload = parseQueueSendWorkerPayload(job?.data);
        const workerStatusStartedAt = Date.now();
        await recordWorkerJobStart(PRINT_QUEUE_SEND_JOB_NAME);
        console.log(
          `[print-queue-worker] started ${payload.jobId} ` +
          `chunk=${payload.chunkSequence} recovery=${payload.recoveryAttempt} (${job?.id ?? 'unknown'})`,
        );
        const startedAt = Date.now();
        const abortController = new AbortController();
        try {
          const snapshot = await getQueueSendJobRecord(payload.jobId);
          const admission = evaluateQueueSendWorkerAdmission({
            snapshotPresent: Boolean(snapshot),
            snapshotStatus: snapshot?.status ?? null,
            snapshotRecoveryAttempt: snapshot?.recoveryAttempts ?? null,
            payloadRecoveryAttempt: payload.recoveryAttempt ?? 0,
          });
          if (!admission.admit) {
            const result = { skipped: true, reason: admission.reason };
            console.warn(
              `[print-queue-worker] skipped ${payload.jobId} chunk=${payload.chunkSequence} ` +
              `recovery=${payload.recoveryAttempt} reason=${admission.reason}`,
            );
            await recordWorkerJobSuccess(
              PRINT_QUEUE_SEND_JOB_NAME,
              workerStatusStartedAt,
              result,
            );
            return result;
          }
          const durableClaimed = await markQueueSendJobWorkerClaimed(
            payload.jobId,
            payload.recoveryAttempt ?? 0,
          );
          if (!durableClaimed) {
            const result = { skipped: true, reason: 'durable_generation_write_rejected' };
            console.warn(
              `[print-queue-worker] skipped ${payload.jobId} chunk=${payload.chunkSequence} ` +
              `recovery=${payload.recoveryAttempt} reason=${result.reason}`,
            );
            await recordWorkerJobSuccess(
              PRINT_QUEUE_SEND_JOB_NAME,
              workerStatusStartedAt,
              result,
            );
            return result;
          }
          const { runQueueSendJobFromWorker } = await import('./print-queue');
          const handlerPromise = runQueueSendJobFromWorker(payload, {
            signal: abortController.signal,
          });
          let result: Awaited<typeof handlerPromise>;
          try {
            result = await withDeadline(
              () => handlerPromise,
              env.PRINT_QUEUE_WORKER_JOB_TIMEOUT_MS,
              `${PRINT_QUEUE_SEND_JOB_NAME}:${payload.jobId}`,
              {
                // Audit PQ-1: stop admitting new orders. In-flight label work is
                // allowed to settle through its idempotent purchase boundary.
                onTimeout: () => abortController.abort(),
              },
            );
          } catch (error) {
            if (error instanceof DeadlineExceededError) {
              // Per user override unlock shipped data on 2026-07-15: PS-428
              // keeps the pg-boss attempt claimed until every admitted label
              // operation settles. Recovery cannot overlap unknown postage work.
              await handlerPromise.catch(() => undefined);
            }
            throw error;
          }
          await enqueueNextQueueSendChunk(boss!, payload);
          console.log(
            `[print-queue-worker] completed ${payload.jobId} chunk=${payload.chunkSequence} ` +
            `in ${Date.now() - startedAt}ms`,
          );
          await recordWorkerJobSuccess(
            PRINT_QUEUE_SEND_JOB_NAME,
            workerStatusStartedAt,
            result,
          );
          return result;
        } catch (err) {
          const fatalSignal = classifyPrintQueueWorkerFatalError(err);
          if (fatalSignal) noteFatalSignal(fatalSignal);
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
          await recordWorkerJobFailure(
            PRINT_QUEUE_SEND_JOB_NAME,
            workerStatusStartedAt,
            err,
          ).catch(() => undefined);
          throw err;
        }
      },
    );
    startPeriodicRecovery(boss);
    startWorkerHealthMonitor();
    console.log('[print-queue-worker] started');
  } catch (err) {
    started = false;
    const targetBoss = boss;
    boss = null;
    removePgBossWarningListener();
    await targetBoss?.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
    throw err;
  }
}

export async function stopPrintQueueWorker(): Promise<void> {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  removePgBossWarningListener();
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30_000 });
    boss = null;
  }
  if (started) {
    console.log('[print-queue-worker] stopped');
  }
  started = false;
}
