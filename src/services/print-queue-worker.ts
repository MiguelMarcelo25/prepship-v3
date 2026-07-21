import PgBoss from 'pg-boss';
import { z } from 'zod';
import { env } from '../lib/env';
import { jobSingletonSeconds } from '../lib/job-singleton-seconds';
import {
  PRINT_QUEUE_MERGE_HEARTBEAT_INTERVAL_MS,
  PRINT_QUEUE_MERGE_HEARTBEAT_STALE_MS,
  PRINT_QUEUE_WORKER_HANDLER_TIMEOUT_MS,
} from '../lib/print-queue-worker-deadline';
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
  acknowledgeQueueSendJobCancellation,
  advanceQueueSendJobChunk,
  claimRecoverableQueueSendJobRecords,
  claimQueueSendJobManualResume,
  heartbeatQueueSendJobWorkerClaim,
  getQueueSendJobItemRecords,
  getQueueSendJobRecord,
  interruptExhaustedQueueSendJobs,
  markQueueSendJobWorkerClaimed,
  markQueueSendJobInterrupted,
  markQueueSendJobReconciliationWaiting,
  persistQueueSendJobRecord,
  readQueueSendJobRecoverySafety,
  requestQueueSendJobCancellation,
  terminalizeExhaustedQueueSendJobItems,
  updateQueueSendJobItemState,
} from './print-queue/queue-send-job-store';
import { planQueueSendRecovery } from './print-queue/queue-send-recovery';
import { reconcileQueueShipStationOperation } from './print-queue/shipstation-operation-reconciler';
import { QUEUE_SEND_DURABLE_STALE_AFTER_MS } from './print-queue/queue-send-status';
import {
  planQueueSendWorkerChunks,
  QUEUE_SEND_EXECUTION_CHUNK_SIZE,
  QUEUE_SEND_HEARTBEAT_INTERVAL_MS,
  QUEUE_SEND_MAX_PARENT_GENERATIONS,
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
// Per user override unlock shipped data on 2026-07-21: PS-453 shares the
// merge heartbeat thresholds with the backend status owner so a missing
// worker is visible without weakening generation fences or touching labels.
export {
  PRINT_QUEUE_MERGE_HEARTBEAT_INTERVAL_MS,
  PRINT_QUEUE_MERGE_HEARTBEAT_STALE_MS,
} from '../lib/print-queue-worker-deadline';
const PRINT_QUEUE_SEND_SINGLETON_SECONDS = jobSingletonSeconds(24 * 60 * 60 * 1000);
export const PRINT_QUEUE_SEND_CHUNK_SIZE = QUEUE_SEND_EXECUTION_CHUNK_SIZE;
export const PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS = 3;
export const PRINT_QUEUE_SEND_MAX_PARENT_RECOVERY_ATTEMPTS = QUEUE_SEND_MAX_PARENT_GENERATIONS;
export const PRINT_QUEUE_SEND_HEARTBEAT_INTERVAL_MS = QUEUE_SEND_HEARTBEAT_INTERVAL_MS;
export const PRINT_QUEUE_SEND_RECOVERY_INTERVAL_MS = 60_000;
export const PRINT_QUEUE_MERGE_JOB_NAME = 'prepship.print-queue.merge';

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
      // Per user override unlock shipped data on 2026-07-21: PS-444 disables
      // pg-boss redelivery for postage-capable chunks. The durable recovery
      // planner alone may schedule a new generation after provider-pending
      // items have been fenced, preventing overlap after DB-time expiry.
      retryLimit: 0,
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
      retryLimit: 0,
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

export async function resumeQueueSendWorkerJob(jobId: string): Promise<{
  queued: boolean;
  safeOrderCount: number;
  providerPendingCount: number;
}> {
  const snapshot = await claimQueueSendJobManualResume(
    jobId,
    PRINT_QUEUE_SEND_MAX_PARENT_RECOVERY_ATTEMPTS,
  );
  if (!snapshot) {
    return { queued: false, safeOrderCount: 0, providerPendingCount: 0 };
  }
  await terminalizeExhaustedQueueSendJobItems({
    jobId,
    generation: snapshot.generation,
    maxAttempts: PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS,
  });
  const itemStates = await getQueueSendJobItemRecords(jobId);
  const plan = planQueueSendRecovery({
    workerOrders: recoverableOrders(snapshot.workerOrders),
    itemStates,
    results: snapshot.results,
  });
  if (plan.safeOrders.length === 0) {
    await markQueueSendJobInterrupted(
      jobId,
      plan.providerPendingOrderIds.length > 0
        ? `Resume waiting: ${plan.providerPendingOrderIds.length} provider outcome(s) require reconciliation; protected orders were not resent.`
        : 'No safe incomplete orders remain to resume.',
      snapshot.generation,
      snapshot.chunkSequence,
    );
    return {
      queued: false,
      safeOrderCount: 0,
      providerPendingCount: plan.providerPendingOrderIds.length,
    };
  }
  const recoveryAttempt = Math.max(1, Math.floor(snapshot.recoveryAttempts ?? 1));
  let pgBossJobId: string | null = null;
  try {
    pgBossJobId = await sendQueueSendChunk(await getPrintQueueEnqueueBoss(), {
      jobId,
      orders: plan.safeOrders.slice(0, PRINT_QUEUE_SEND_CHUNK_SIZE),
      concurrency: snapshot.workerConcurrency ?? undefined,
      scope: snapshot.workerScope ?? {},
      requestedAt: new Date().toISOString(),
      chunkSequence: 1,
      recoveryAttempt,
    });
  } catch (error) {
    await markQueueSendJobInterrupted(
      jobId,
      `Safe-order resume could not be queued: ${error instanceof Error ? error.message : String(error)}`,
      snapshot.generation,
      snapshot.chunkSequence,
    ).catch(() => undefined);
    throw error;
  }
  if (!pgBossJobId) {
    await markQueueSendJobInterrupted(
      jobId,
      'Safe-order resume was deduplicated; verify worker health and retry.',
      snapshot.generation,
      snapshot.chunkSequence,
    );
  }
  return {
    queued: Boolean(pgBossJobId),
    safeOrderCount: plan.safeOrders.length,
    providerPendingCount: plan.providerPendingOrderIds.length,
  };
}

async function markRecoverableJobInterrupted(
  snapshot: Awaited<ReturnType<typeof claimRecoverableQueueSendJobRecords>>[number],
): Promise<void> {
  await markQueueSendJobInterrupted(
    snapshot.jobId,
    'Queue job interrupted before a durable worker payload was available; verify the queue and retry.',
    snapshot.generation,
    snapshot.chunkSequence,
  );
}

async function recoverStaleQueueSendJobs(targetBoss: PgBoss): Promise<QueueSendWorkerRecoveryResult> {
  const exhausted = await interruptExhaustedQueueSendJobs({
    staleAfterMs: QUEUE_SEND_DURABLE_STALE_AFTER_MS,
    maxAttempts: PRINT_QUEUE_SEND_MAX_PARENT_RECOVERY_ATTEMPTS,
  });
  const snapshots = await claimRecoverableQueueSendJobRecords({
    staleAfterMs: QUEUE_SEND_DURABLE_STALE_AFTER_MS,
    maxAttempts: PRINT_QUEUE_SEND_MAX_PARENT_RECOVERY_ATTEMPTS,
    limit: 25,
  });
  let requeued = 0;
  let interrupted = exhausted;

  for (const snapshot of snapshots) {
    const recoveryLeaseCurrent = await heartbeatQueueSendJobWorkerClaim(
      snapshot.jobId,
      snapshot.generation,
      1,
    ).catch(() => false);
    if (!recoveryLeaseCurrent) {
      interrupted += 1;
      continue;
    }
    let recoverySafety: Awaited<ReturnType<typeof readQueueSendJobRecoverySafety>>;
    try {
      recoverySafety = await readQueueSendJobRecoverySafety(snapshot.jobId);
    } catch (err) {
      await markQueueSendJobInterrupted(
        snapshot.jobId,
        'Recovery safety state could not be read; verify the durable item records before retrying.',
        snapshot.generation,
        snapshot.chunkSequence,
      ).catch(() => undefined);
      console.error(
        `[print-queue-worker] recovery safety read failed jobId=${snapshot.jobId}:`,
        err instanceof Error ? err.message : err,
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
    // Per user override unlock shipped data on 2026-07-21: PS-452 parks only
    // safe pre-provider items that consumed the bounded attempt budget. Unknown
    // provider outcomes remain fenced for exact reconciliation and are never
    // converted into a retry or synthetic terminal failure.
    await terminalizeExhaustedQueueSendJobItems({
      jobId: snapshot.jobId,
      generation: snapshot.generation,
      maxAttempts: PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS,
    });
    let itemStates = await getQueueSendJobItemRecords(snapshot.jobId);
    const ordersById = new Map(orders.map((order) => [order.orderId, order]));
    let reconciliationLeaseCurrent = true;
    for (const item of itemStates) {
      if (item.state !== 'provider_pending' && item.state !== 'provider_pending_recovery') continue;
      const order = ordersById.get(item.orderId);
      if (!order) continue;
      try {
        const reconciliation = await reconcileQueueShipStationOperation(
          order,
          snapshot.workerScope ?? {},
        );
        if (reconciliation.status === 'recovered') {
          await updateQueueSendJobItemState(snapshot.jobId, order.orderId, {
            clientId: order.clientId,
            attemptCount: 0,
            generation: snapshot.generation,
            state: 'shipment_persisted',
            blockedReason: null,
            errorMessage: null,
            trackingNumber: reconciliation.trackingNumber,
          });
        } else if (reconciliation.status === 'resume_receipt') {
          await updateQueueSendJobItemState(snapshot.jobId, order.orderId, {
            clientId: order.clientId,
            attemptCount: 0,
            generation: snapshot.generation,
            state: 'receipt_resume',
            blockedReason: 'provider_receipt_ready_for_local_resume',
            errorMessage: null,
          });
        } else if (reconciliation.status === 'no_effect') {
          await updateQueueSendJobItemState(snapshot.jobId, order.orderId, {
            clientId: order.clientId,
            attemptCount: item.attemptCount,
            generation: snapshot.generation,
            state: 'ready',
            blockedReason: null,
            errorMessage: null,
          });
        }
      } catch (error) {
        console.warn(
          `[print-queue-worker] exact provider reconciliation held jobId=${snapshot.jobId} orderId=${order.orderId}:`,
          error instanceof Error ? error.message : error,
        );
      } finally {
        // Per user override unlock shipped data on 2026-07-21: PS-452 recovery
        // may inspect many ambiguous provider outcomes. Renew
        // the exact pending-generation lease between bounded provider reads so
        // another reaper cannot advance the generation mid-reconciliation.
        reconciliationLeaseCurrent = await heartbeatQueueSendJobWorkerClaim(
          snapshot.jobId,
          snapshot.generation,
          1,
        ).catch(() => false);
      }
      if (!reconciliationLeaseCurrent) break;
    }
    if (!reconciliationLeaseCurrent) {
      interrupted += 1;
      continue;
    }
    itemStates = await getQueueSendJobItemRecords(snapshot.jobId);
    try {
      recoverySafety = await readQueueSendJobRecoverySafety(snapshot.jobId);
    } catch (error) {
      await markQueueSendJobInterrupted(
        snapshot.jobId,
        'Recovery safety state could not be refreshed after provider reconciliation.',
        snapshot.generation,
        snapshot.chunkSequence,
      ).catch(() => undefined);
      interrupted += 1;
      continue;
    }
    const recoveryPlan = planQueueSendRecovery({
      workerOrders: orders,
      itemStates,
      results: snapshot.results,
    });
    const providerPendingPresent = !canAutomaticallyRecoverQueueSendJob(
      recoverySafety.providerPendingCount,
    );
    if (providerPendingPresent !== (recoveryPlan.providerPendingOrderIds.length > 0)) {
      await markQueueSendJobInterrupted(
        snapshot.jobId,
        'Recovery safety state changed while the job was being planned; retry after the next durable recovery pass.',
        snapshot.generation,
        snapshot.chunkSequence,
      );
      interrupted += 1;
      continue;
    }
    const remainingOrders = recoveryPlan.safeOrders;
    if (!remainingOrders.length && recoveryPlan.providerPendingOrderIds.length > 0) {
      // Per user override unlock shipped data on 2026-07-21: PS-444 keeps only
      // unknown provider outcomes fenced. It never resends those orders, while
      // unrelated safe orders in the same batch are allowed to continue.
      await markQueueSendJobReconciliationWaiting(
        snapshot.jobId,
        `Recovery waiting: ${recoveryPlan.providerPendingOrderIds.length} provider outcome(s) require reconciliation; no safe orders remain.`,
        snapshot.generation,
      );
      interrupted += 1;
      continue;
    }
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
            `Recovery generation ${recoveryAttempt}/${PRINT_QUEUE_SEND_MAX_PARENT_RECOVERY_ATTEMPTS} ` +
            `queued for ${Math.min(remainingOrders.length, PRINT_QUEUE_SEND_CHUNK_SIZE)} safe remaining orders` +
            (recoveryPlan.providerPendingOrderIds.length > 0
              ? `; ${recoveryPlan.providerPendingOrderIds.length} provider outcome(s) remain fenced`
              : ''),
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
          `Recovery generation ${recoveryAttempt}/${PRINT_QUEUE_SEND_MAX_PARENT_RECOVERY_ATTEMPTS} was deduplicated; verify the queue before retrying.`,
          snapshot.generation,
          snapshot.chunkSequence,
        );
        interrupted += 1;
      }
    } catch (err) {
      await markQueueSendJobInterrupted(
        snapshot.jobId,
        `Recovery generation ${recoveryAttempt}/${PRINT_QUEUE_SEND_MAX_PARENT_RECOVERY_ATTEMPTS} could not be queued: ${err instanceof Error ? err.message : String(err)}`,
        snapshot.generation,
        snapshot.chunkSequence,
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
  const itemStates = await getQueueSendJobItemRecords(payload.jobId);
  const recoveryPlan = planQueueSendRecovery({
    workerOrders: recoverableOrders(snapshot.workerOrders),
    itemStates,
    results: snapshot.results,
  });
  const remainingOrders = recoveryPlan.safeOrders;
  if (!remainingOrders.length) {
    if (recoveryPlan.providerPendingOrderIds.length > 0) {
      await markQueueSendJobInterrupted(
        payload.jobId,
        `Queue batch paused with ${recoveryPlan.providerPendingOrderIds.length} provider outcome(s) awaiting reconciliation; protected orders were not resent.`,
        payload.recoveryAttempt ?? 0,
        payload.chunkSequence ?? 1,
      );
    }
    return;
  }

  const nextPayload: QueueSendWorkerPayload = {
    jobId: snapshot.jobId,
    orders: remainingOrders.slice(0, PRINT_QUEUE_SEND_CHUNK_SIZE),
    concurrency: snapshot.workerConcurrency ?? undefined,
    scope: snapshot.workerScope ?? {},
    requestedAt: new Date().toISOString(),
    chunkSequence: (payload.chunkSequence ?? 1) + 1,
    recoveryAttempt: payload.recoveryAttempt ?? snapshot.recoveryAttempts ?? 0,
  };
  const generation = payload.recoveryAttempt ?? snapshot.generation;
  const advanced = await advanceQueueSendJobChunk({
    jobId: payload.jobId,
    generation,
    currentChunkSequence: payload.chunkSequence ?? 1,
    nextChunkSequence: nextPayload.chunkSequence ?? 1,
  });
  if (!advanced) {
    throw new Error(
      `Queue continuation lost its durable fence for ${payload.jobId} generation ${generation}`,
    );
  }
  try {
    const pgBossJobId = await sendQueueSendChunk(targetBoss, nextPayload);
    if (!pgBossJobId) {
      const message =
        `Queue continuation chunk ${nextPayload.chunkSequence} was not accepted; ` +
        'the batch is visibly interrupted and safe to recover.';
      await markQueueSendJobInterrupted(
        payload.jobId,
        message,
        generation,
        nextPayload.chunkSequence,
      );
      throw new Error(message);
    }
  } catch (error) {
    await markQueueSendJobInterrupted(
      payload.jobId,
      `Queue continuation chunk ${nextPayload.chunkSequence} could not be queued: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      generation,
      nextPayload.chunkSequence,
    ).catch(() => undefined);
    throw error;
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
            snapshotRecoveryAttempt: snapshot?.generation ?? null,
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
            payload.chunkSequence ?? 1,
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
          // Per user override unlock shipped data on 2026-07-21: PS-452
          // heartbeats the exact generation/chunk claim. Losing that fence
          // cooperatively stops new admissions and never authorizes a resend.
          let heartbeatFailure: Error | null = null;
          const heartbeatTimer = setInterval(() => {
            void heartbeatQueueSendJobWorkerClaim(
              payload.jobId,
              payload.recoveryAttempt ?? 0,
              payload.chunkSequence ?? 1,
            ).then((current) => {
              if (!current && !heartbeatFailure) {
                heartbeatFailure = new Error(
                  `Queue chunk ${payload.chunkSequence} lost its durable generation fence`,
                );
                abortController.abort(heartbeatFailure);
              }
            }).catch((error) => {
              if (!heartbeatFailure) {
                heartbeatFailure = error instanceof Error ? error : new Error(String(error));
                abortController.abort(heartbeatFailure);
              }
            });
          }, PRINT_QUEUE_SEND_HEARTBEAT_INTERVAL_MS);
          heartbeatTimer.unref?.();
          const handlerPromise = runQueueSendJobFromWorker(payload, {
            signal: abortController.signal,
          });
          let result: Awaited<typeof handlerPromise>;
          try {
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
              if (heartbeatFailure) throw heartbeatFailure;
            } catch (error) {
              if (error instanceof DeadlineExceededError) {
                await requestQueueSendJobCancellation(
                  payload.jobId,
                  payload.recoveryAttempt ?? 0,
                  payload.chunkSequence ?? 1,
                ).catch(() => false);
                // Keep the pg-boss attempt claimed until every admitted label
                // operation settles. Recovery cannot overlap unknown postage work.
                await handlerPromise.catch(() => undefined);
                await acknowledgeQueueSendJobCancellation(
                  payload.jobId,
                  payload.recoveryAttempt ?? 0,
                  payload.chunkSequence ?? 1,
                ).catch(() => false);
              }
              if (heartbeatFailure) throw heartbeatFailure;
              throw error;
            }
          } finally {
            clearInterval(heartbeatTimer);
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
          await terminalizeExhaustedQueueSendJobItems({
            jobId: payload.jobId,
            generation: payload.recoveryAttempt ?? 0,
            maxAttempts: PRINT_QUEUE_SEND_MAX_RECOVERY_ATTEMPTS,
          }).catch(() => 0);
          if (err instanceof DeadlineExceededError) {
            // Per user override unlock shipped data on 2026-07-14: timeout
            // persistence changes durable queue metadata only. It does not
            // cancel/repurchase postage or mutate shipped order history.
            await markQueueSendJobInterrupted(
              payload.jobId,
              `Queue chunk ${payload.chunkSequence} timed out after ${env.PRINT_QUEUE_WORKER_JOB_TIMEOUT_MS}ms ` +
              `(generation ${payload.recoveryAttempt}/${PRINT_QUEUE_SEND_MAX_PARENT_RECOVERY_ATTEMPTS}); no new orders will be admitted.`,
              payload.recoveryAttempt ?? 0,
              payload.chunkSequence ?? 1,
            ).catch(() => undefined);
          } else {
            await markQueueSendJobInterrupted(
              payload.jobId,
              `Queue chunk ${payload.chunkSequence} interrupted: ` +
                `${err instanceof Error ? err.message : String(err)}`,
              payload.recoveryAttempt ?? 0,
              payload.chunkSequence ?? 1,
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
