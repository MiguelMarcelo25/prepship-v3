import PgBoss from 'pg-boss';
import { env } from '../lib/env';
import type { DurableRateBackfillJobPayload } from './rate-backfill-job-types';

export const RATE_BACKFILL_JOB_NAME = 'prepship.sync.rate-backfill';

export type DurableRateBackfillEnqueueResult = {
  queued: boolean;
  queueJobId: string | null;
  error: string | null;
};

let producerPromise: Promise<PgBoss> | null = null;

function getRateBackfillProducer(): Promise<PgBoss> {
  if (producerPromise) return producerPromise;
  producerPromise = (async () => {
    const producer = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: env.PG_BOSS_SCHEMA,
      application_name: 'prepship-rate-backfill-producer',
      max: 1,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 30 * 60,
      retentionDays: 7,
      deleteAfterDays: 7,
      supervise: false,
    });
    try {
      producer.on('error', (error) => {
        console.error('[rate-backfill-producer] pg-boss error:', error.message);
      });
      await producer.start();
      await producer.createQueue(RATE_BACKFILL_JOB_NAME, {
        name: RATE_BACKFILL_JOB_NAME,
        policy: 'standard',
        retryLimit: 2,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: 30 * 60,
        retentionDays: 7,
      });
      return producer;
    } catch (error) {
      await producer.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
      throw error;
    }
  })().catch((error) => {
    producerPromise = null;
    throw error;
  });
  return producerPromise;
}

/**
 * Persist one explicit rate request in the same pg-boss lane as cadence work.
 * The process-local producer client owns no workflow truth; PostgreSQL owns
 * the job. Reusing its one connection avoids starting pg-boss per import page.
 */
export async function enqueueDurableRateBackfillJob(
  payload: DurableRateBackfillJobPayload,
): Promise<DurableRateBackfillEnqueueResult> {
  try {
    const producer = await getRateBackfillProducer();
    const queueJobId = await producer.send(RATE_BACKFILL_JOB_NAME, payload, {
      id: payload.jobId,
      priority: payload.requestedBy === 'manual' ? 1_000 : 100,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInMinutes: 30,
      retentionDays: 7,
    });
    return {
      queued: Boolean(queueJobId),
      queueJobId: queueJobId ? String(queueJobId) : null,
      error: queueJobId ? null : 'pg-boss did not admit the rate backfill job',
    };
  } catch (error) {
    return {
      queued: false,
      queueJobId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
