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
import {
  startPrintQueueWorker,
  stopPrintQueueWorker,
} from './services/print-queue-worker';
import { ensureOrdersPerformanceIndexes } from './services/orders-performance-maintenance';
import { ensureReportingMetricsTables } from './services/reporting-metrics';
import {
  startShipStationCarrierAccountSnapshotWorker,
  stopShipStationCarrierAccountSnapshotWorker,
} from './services/shipstation-carrier-account-snapshot-worker';

let keepAliveTimer: NodeJS.Timeout | null = null;

function startKeepAliveHeartbeat(): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    void recordWorkerHeartbeat();
  }, 30_000);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`[worker] received ${signal}; shutting down`);
  await stopPrintQueueWorker();
  if (env.RUN_SYNC_SCHEDULER) {
    await stopShipStationCarrierAccountSnapshotWorker();
    if (env.USE_PG_BOSS_SCHEDULER) {
      await stopQueuedSyncScheduler();
    } else {
      stopSyncScheduler();
    }
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
  // PS-232: full stack only when explicitly enabled (WORKER_DEBUG_STACKS=1) —
  // keep raw stacks out of default logs; name+message above is enough to triage.
  if (reason instanceof Error && reason.stack && process.env.WORKER_DEBUG_STACKS === '1') {
    console.error(reason.stack);
  }
});

process.on('uncaughtException', (err) => {
  console.error(
    '[worker:uncaughtException]',
    err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  );
  // PS-232: full stack only when WORKER_DEBUG_STACKS=1 (see unhandledRejection above).
  if (err instanceof Error && err.stack && process.env.WORKER_DEBUG_STACKS === '1') {
    console.error(err.stack);
  }
});

async function main(): Promise<void> {
  console.log('[worker] PrepShip worker booting');
  console.log(
    `[worker] RUN_SYNC_SCHEDULER=${env.RUN_SYNC_SCHEDULER}; RUN_PRINT_QUEUE_WORKER=${env.RUN_PRINT_QUEUE_WORKER}; WORKER_PLACEHOLDER=${env.WORKER_PLACEHOLDER}; USE_PG_BOSS_SCHEDULER=${env.USE_PG_BOSS_SCHEDULER}`
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

  if (env.RUN_PRINT_QUEUE_WORKER) {
    console.log('[worker] starting print queue worker');
    await startPrintQueueWorker();
  }

  if (env.RUN_SYNC_SCHEDULER) {
    startShipStationCarrierAccountSnapshotWorker();
    if (env.USE_PG_BOSS_SCHEDULER) {
      console.log('[worker] starting pg-boss sync scheduler');
      await startQueuedSyncScheduler();
    } else {
      console.warn(
        '[worker] USE_PG_BOSS_SCHEDULER=false; ShipStation imports are disabled, starting ancillary scheduler only',
      );
      startSyncScheduler({ mode: 'worker-scheduler' });
    }
  } else {
    if (env.RUN_PRINT_QUEUE_WORKER) {
      console.log('[worker] RUN_SYNC_SCHEDULER=false; print queue worker running');
      await setWorkerMode('print-worker');
    } else {
      console.log('[worker] RUN_SYNC_SCHEDULER=false; worker is idle');
      await setWorkerMode('disabled');
    }
    startKeepAliveHeartbeat();
  }
}

void main();
