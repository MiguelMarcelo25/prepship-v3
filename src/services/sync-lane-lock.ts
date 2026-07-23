// Per user override unlock shipped data on 2026-07-01: queue lane ownership
// only. This lock coordinates sync workers; it does not read or mutate orders,
// shipments, labels, postage, marketplace notifications, or customer data.
import postgres from 'postgres';
import { env } from '../lib/env';
import { SYNC_JOB_RUNNING_LEASE_MS } from '../lib/sync-job-deadline';
import { SYNC_JOB_LANE_VALUES, type SyncJobLane } from './sync-job-lanes';

const SYNC_LANE_LOCK_PREFIX = 'prepship.sync.lane';
export const SYNC_LANE_LOCK_POOL_MAX = SYNC_JOB_LANE_VALUES.length;
export const SYNC_LANE_IDLE_TRANSACTION_TIMEOUT_MS = SYNC_JOB_RUNNING_LEASE_MS + 5_000;

// Per user override unlock shipped data on 2026-07-02: keep lane-lock
// transactions off the shared app DB pool. Render production can run
// DB_POOL_MAX=1, and holding that connection during a ShipStation walk starves
// worker heartbeat/status writes, making the UI show a false stale-sync badge.
const laneLockSql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: SYNC_LANE_LOCK_POOL_MAX,
  idle_timeout: env.DB_IDLE_TIMEOUT_SECONDS,
  connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
  connection: {
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    // Per user override unlock shipped data on 2026-07-18: Supavisor can
    // retain an advisory-lock transaction after an abrupt worker exit. The
    // database now releases that queue-control transaction shortly after the
    // bounded worker lease, even if the dead client never rolls it back.
    idle_in_transaction_session_timeout: SYNC_LANE_IDLE_TRANSACTION_TIMEOUT_MS,
  },
});

export type SyncLaneLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false; result: null };

export function syncLaneLockName(lane: SyncJobLane): string {
  return `${SYNC_LANE_LOCK_PREFIX}.${lane}`;
}

export async function withSyncLaneAdvisoryLock<T>(
  lane: SyncJobLane,
  fn: () => Promise<T>,
): Promise<SyncLaneLockResult<T>> {
  const lockName = syncLaneLockName(lane);
  return laneLockSql.begin(async (tx) => {
    const [row] = await tx<{ acquired: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext(${lockName})) as acquired
    `;
    const acquired = Boolean(row?.acquired);
    if (!acquired) return { acquired: false, result: null };
    return { acquired: true, result: await fn() };
  });
}

export async function isSyncLaneAdvisoryLockHeld(lane: SyncJobLane): Promise<boolean> {
  const lockName = syncLaneLockName(lane);
  const rows = await laneLockSql.begin((tx) => tx<{ acquired: boolean }[]>`
    select pg_try_advisory_xact_lock(hashtext(${lockName})) as acquired
  `);
  return !Boolean(rows[0]?.acquired);
}
