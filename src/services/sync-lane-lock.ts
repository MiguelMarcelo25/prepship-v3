// Per user override unlock shipped data on 2026-07-01: queue lane ownership
// only. This lock coordinates sync workers; it does not read or mutate orders,
// shipments, labels, postage, marketplace notifications, or customer data.
import { sql as pg } from '../db/client';
import type { SyncJobLane } from './sync-job-lanes';

const SYNC_LANE_LOCK_PREFIX = 'prepship.sync.lane';

export type SyncLaneLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false; result: null };

export async function withSyncLaneAdvisoryLock<T>(
  lane: SyncJobLane,
  fn: () => Promise<T>,
): Promise<SyncLaneLockResult<T>> {
  const lockName = `${SYNC_LANE_LOCK_PREFIX}.${lane}`;
  return pg.begin(async (tx) => {
    const [row] = await tx<{ acquired: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext(${lockName})) as acquired
    `;
    const acquired = Boolean(row?.acquired);
    if (!acquired) return { acquired: false, result: null };
    return { acquired: true, result: await fn() };
  });
}
