import PgBoss from 'pg-boss';
import { z } from 'zod';
import { env } from '../lib/env';
import { withDeadline } from '../lib/with-deadline';
import type { PrintQueueListScope, QueueSendOrderInput } from './print-queue';

export const PRINT_QUEUE_SEND_JOB_NAME = 'prepship.print-queue.batch-send';

const scopeSchema = z.object({
  scopeClientIds: z.array(z.number().int().positive()).optional(),
  scopeStoreIds: z.array(z.number().int().positive()).optional(),
  scopeRestricted: z.boolean().optional(),
}).optional();

const payloadSchema = z.object({
  jobId: z.string().min(1),
  orders: z.array(z.unknown()).min(1).max(200),
  concurrency: z.number().int().min(1).max(8).optional(),
  scope: scopeSchema,
  requestedAt: z.string().optional(),
});

export type QueueSendWorkerPayload = {
  jobId: string;
  orders: QueueSendOrderInput[];
  concurrency?: number;
  scope?: PrintQueueListScope;
  requestedAt?: string;
};

export type QueueSendWorkerEnqueueResult = {
  queued: boolean;
  pgBossJobId: string | null;
  error: string | null;
};

let boss: PgBoss | null = null;
let started = false;

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

function parseQueueSendWorkerPayload(value: unknown): QueueSendWorkerPayload {
  const parsed = payloadSchema.parse(value);
  return {
    jobId: parsed.jobId,
    orders: parsed.orders as QueueSendOrderInput[],
    concurrency: parsed.concurrency,
    scope: parsed.scope,
    requestedAt: parsed.requestedAt,
  };
}

export async function enqueueQueueSendWorkerJob(
  payload: QueueSendWorkerPayload,
): Promise<QueueSendWorkerEnqueueResult> {
  const targetBoss = createPrintQueueBoss('prepship-api-print-queue-enqueue', 1);
  try {
    await targetBoss.start();
    await ensurePrintQueueSendQueue(targetBoss);
    const pgBossJobId = await targetBoss.send(
      PRINT_QUEUE_SEND_JOB_NAME,
      {
        ...payload,
        requestedAt: payload.requestedAt ?? new Date().toISOString(),
      },
      {
        singletonKey: payload.jobId,
        singletonSeconds: 24 * 60 * 60,
        retryLimit: 1,
        retryDelay: 30,
        retryBackoff: true,
        expireInMinutes: 30,
        retentionDays: 7,
      },
    );
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
  } finally {
    await targetBoss.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
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
    await boss.work(
      PRINT_QUEUE_SEND_JOB_NAME,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]) => {
        const payload = parseQueueSendWorkerPayload(job?.data);
        console.log(`[print-queue-worker] started ${payload.jobId} (${job?.id ?? 'unknown'})`);
        const startedAt = Date.now();
        try {
          const { runQueueSendJobFromWorker } = await import('./print-queue');
          const result = await withDeadline(
            () => runQueueSendJobFromWorker(payload),
            env.PRINT_QUEUE_WORKER_JOB_TIMEOUT_MS,
            `${PRINT_QUEUE_SEND_JOB_NAME}:${payload.jobId}`,
          );
          console.log(
            `[print-queue-worker] completed ${payload.jobId} in ${Date.now() - startedAt}ms`,
          );
          return result;
        } catch (err) {
          console.error(
            `[print-queue-worker] failed ${payload.jobId} after ${Date.now() - startedAt}ms:`,
            err instanceof Error ? err.message : err,
          );
          throw err;
        }
      },
    );
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
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30_000 });
    boss = null;
  }
  if (started) {
    console.log('[print-queue-worker] stopped');
  }
  started = false;
}
