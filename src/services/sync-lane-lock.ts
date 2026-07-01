// Per user override unlock shipped data on 2026-07-01: queue lane ownership
// only. This lock coordinates sync workers; it does not read or mutate orders,
// shipments, labels, postage, marketplace notifications, or customer data.
import postgres from 'postgres';
import { env } from '../lib/env';
import type { SyncJobLane } from './sync-job-lanes';

const SYNC_LANE_LOCK_PREFIX = 'prepship.sync.lane';
const SYNC_LANE_LOCK_POOL_MAX = 3; // one reserved transaction per sync lane

// Per user override unlock shipped data on 2026-07-02: keep lane-lock
// transactions off the shared app DB pool. Render production can run
// DB_POOL_MAX=1, and holding that connection during a ShipStation walk starves
// worker heartbeat/status writes, making the UI show a false stale-sync badge.
const laneLockSql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: SYNC_LANE_LOCK_POOL_MAX,
  idle_timeout: env.DB_IDLE_TIMEOUT_SECONDS,
  connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
  connection: { statement_timeout: env.DB_STATEMENT_TIMEOUT_MS },
});

export type SyncLaneLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false; result: null };

export async function withSyncLaneAdvisoryLock<T>(
  lane: SyncJobLane,
  fn: () => Promise<T>,
): Promise<SyncLaneLockResult<T>> {
  const lockName = `${SYNC_LANE_LOCK_PREFIX}.${lane}`;
  return laneLockSql.begin(async (tx) => {
    const [row] = await tx<{ acquired: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext(${lockName})) as acquired
    `;
    const acquired = Boolean(row?.acquired);
    if (!acquired) return { acquired: false, result: null };
    return { acquired: true, result: await fn() };
  });
}
