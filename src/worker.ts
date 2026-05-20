import { env } from './lib/env';
import {
  recordWorkerHeartbeat,
  setWorkerMode,
} from './services/worker-status';
import {
  startSyncScheduler,
  stopSyncScheduler,
} from './services/sync-scheduler';
import {
  startQueuedSyncScheduler,
  stopQueuedSyncScheduler,
} from './services/sync-job-queue';
import { ensureOrdersPerformanceIndexes } from './services/orders-performance-maintenance';
import { ensureReportingMetricsTables } from './services/reporting-metrics';

let keepAliveTimer: NodeJS.Timeout | null = null;

function startKeepAliveHeartbeat(): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    void recordWorkerHeartbeat();
  }, 30_000);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`[worker] received ${signal}; shutting down`);
  if (env.USE_PG_BOSS_SCHEDULER) {
    await stopQueuedSyncScheduler();
  } else {
    stopSyncScheduler();
  }
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  await setWorkerMode('disabled');
  process.exit(0);
}

process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));

process.on('unhandledRejection', (reason) => {
  const msg =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : String(reason);
  console.error('[worker:unhandledRejection]', msg);
  if (reason instanceof Error && reason.stack) console.error(reason.stack);
});

process.on('uncaughtException', (err) => {
  console.error(
    '[worker:uncaughtException]',
    err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  );
  if (err instanceof Error && err.stack) console.error(err.stack);
});

async function main(): Promise<void> {
  console.log('[worker] PrepShip worker booting');
  console.log(
    `[worker] RUN_SYNC_SCHEDULER=${env.RUN_SYNC_SCHEDULER}; WORKER_PLACEHOLDER=${env.WORKER_PLACEHOLDER}; USE_PG_BOSS_SCHEDULER=${env.USE_PG_BOSS_SCHEDULER}`
  );

  if (env.WORKER_PLACEHOLDER) {
    console.log('[worker] placeholder mode enabled; sync scheduler is not running');
    await setWorkerMode('placeholder');
    startKeepAliveHeartbeat();
    return;
  }

  const runMaintenance = env.RUN_ORDERS_PERFORMANCE_MAINTENANCE === true;

  if (runMaintenance) {
    console.log(
      '[worker] RUN_ORDERS_PERFORMANCE_MAINTENANCE=true; starting orders performance maintenance'
    );
    ensureOrdersPerformanceIndexes();
    void ensureReportingMetricsTables()
      .then(() => console.log('[worker] reporting metrics tables ready'))
      .catch((err) =>
        console.error(
          '[worker] reporting metrics table check failed:',
          err instanceof Error ? err.message : err
        )
      );
  } else {
    console.log(
      '[worker] orders performance maintenance disabled; set RUN_ORDERS_PERFORMANCE_MAINTENANCE=true to run explicitly'
    );
  }

  if (env.RUN_SYNC_SCHEDULER) {
    if (env.USE_PG_BOSS_SCHEDULER) {
      console.log('[worker] starting pg-boss sync scheduler');
      await startQueuedSyncScheduler();
    } else {
      console.log('[worker] starting interval sync scheduler');
      startSyncScheduler({ mode: 'worker-scheduler' });
    }
  } else {
    console.log('[worker] RUN_SYNC_SCHEDULER=false; worker is idle');
    await setWorkerMode('disabled');
    startKeepAliveHeartbeat();
  }
}

void main();
