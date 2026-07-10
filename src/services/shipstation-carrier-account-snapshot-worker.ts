import postgres from 'postgres';
import { env } from '../lib/env.js';
import { refreshDueShipStationCarrierAccountSnapshots } from './shipstation-carrier-account-snapshots.js';

const LOCK_NAME = 'prepship.worker.shipstation-carrier-account-snapshots';
const POLL_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 10_000;

const lockSql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: 1,
  idle_timeout: env.DB_IDLE_TIMEOUT_SECONDS,
  connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
  connection: { statement_timeout: env.DB_STATEMENT_TIMEOUT_MS },
});

let startupTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let activeRun: Promise<void> | null = null;

async function runWithAdvisoryLock(): Promise<void> {
  const reserved = await lockSql.reserve();
  try {
    const [row] = await reserved<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(hashtext(${LOCK_NAME})) as acquired
    `;
    if (!row?.acquired) {
      console.log('[carrier-snapshot-worker] skipped; another worker holds the refresh lock');
      return;
    }
    try {
      const startedAt = Date.now();
      const summary = await refreshDueShipStationCarrierAccountSnapshots();
      const { credentialDbError, ...counts } = summary;
      console.log('[carrier-snapshot-worker] refresh complete', {
        ...counts,
        credentialDbError: Boolean(credentialDbError),
        durationMs: Date.now() - startedAt,
      });
    } finally {
      await reserved`select pg_advisory_unlock(hashtext(${LOCK_NAME}))`;
    }
  } finally {
    reserved.release();
  }
}

export function runShipStationCarrierAccountSnapshotTick(): Promise<void> {
  if (activeRun) return activeRun;
  activeRun = runWithAdvisoryLock()
    .catch((error) => {
      console.error(
        '[carrier-snapshot-worker] refresh failed:',
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      activeRun = null;
    });
  return activeRun;
}

export function startShipStationCarrierAccountSnapshotWorker(): void {
  if (startupTimer || pollTimer) return;
  console.log(
    `[carrier-snapshot-worker] enabled; checking durable snapshots every ${POLL_INTERVAL_MS / 1000}s`,
  );
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runShipStationCarrierAccountSnapshotTick();
  }, STARTUP_DELAY_MS);
  pollTimer = setInterval(() => {
    void runShipStationCarrierAccountSnapshotTick();
  }, POLL_INTERVAL_MS);
}

export async function stopShipStationCarrierAccountSnapshotWorker(): Promise<void> {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  await activeRun;
}
