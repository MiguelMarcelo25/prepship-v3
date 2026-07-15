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

export type OrderSyncQueueState = 'idle' | 'queued' | 'running' | 'retrying';

export function orderSyncQueueState(truth: OrderSyncQueueTruth): OrderSyncQueueState {
  if (truth.activeJobIds.length > 0) return 'running';
  if (truth.retryingJobIds.length > 0) return 'retrying';
  if (truth.queuedJobIds.length > 0) return 'queued';
  return 'idle';
}

export function orderSyncQueueBlocker(
  truth: OrderSyncQueueTruth,
): { state: Exclude<OrderSyncQueueState, 'idle'>; jobId: string } | null {
  const state = orderSyncQueueState(truth);
  if (state === 'idle') return null;
  const jobId = state === 'running'
    ? truth.activeJobIds[0]
    : state === 'retrying'
      ? truth.retryingJobIds[0]
      : truth.queuedJobIds[0];
  return jobId ? { state, jobId } : null;
}

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
