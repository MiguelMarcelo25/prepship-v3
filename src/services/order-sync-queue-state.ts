import { sql as pg } from '../db/client';
import { env } from '../lib/env';

const ORDER_SYNC_JOB_NAME = 'prepship.sync.orders';

type OrderSyncQueueRow = {
  id: string;
  state: string;
};

export type OrderSyncQueueTruth = {
  available: boolean;
  activeJobIds: string[];
  retryingJobIds: string[];
  queuedJobIds: string[];
};

const unavailableQueueTruth = (): OrderSyncQueueTruth => ({
  available: false,
  activeJobIds: [],
  retryingJobIds: [],
  queuedJobIds: [],
});

export function classifyOrderSyncQueueRows(
  rows: ReadonlyArray<OrderSyncQueueRow>,
): OrderSyncQueueTruth {
  return {
    available: true,
    activeJobIds: rows.filter((row) => row.state === 'active').map((row) => row.id),
    retryingJobIds: rows.filter((row) => row.state === 'retry').map((row) => row.id),
    queuedJobIds: rows.filter((row) => row.state === 'created').map((row) => row.id),
  };
}

export async function readOrderSyncQueueTruth(): Promise<OrderSyncQueueTruth> {
  if (!env.USE_PG_BOSS_SCHEDULER) return unavailableQueueTruth();

  try {
    const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
    const rows = await pg<OrderSyncQueueRow[]>`
      SELECT id::text AS id, state
      FROM ${pg(jobTable)}
      WHERE name = ${ORDER_SYNC_JOB_NAME}
        AND state IN ('active', 'retry', 'created')
    `;
    return classifyOrderSyncQueueRows(rows);
  } catch {
    return unavailableQueueTruth();
  }
}
