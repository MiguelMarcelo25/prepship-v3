import { env } from './lib/env';
import {
  recordWorkerHeartbeat,
  setWorkerMode,
} from './services/worker-status';
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
import { startSyncStalenessWatchdog } from './services/sync-staleness-watchdog';
import { assertRuntimeSchemaReady } from './services/runtime-schema-readiness.js';

let keepAliveTimer: NodeJS.Timeout | null = null;
let stopSyncWatchdog: (() => void) | null = null;

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
    await stopQueuedSyncScheduler();
    stopSyncWatchdog?.();
    stopSyncWatchdog = null;
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
    `[worker] RUN_SYNC_SCHEDULER=${env.RUN_SYNC_SCHEDULER}; RUN_PRINT_QUEUE_WORKER=${env.RUN_PRINT_QUEUE_WORKER}; WORKER_PLACEHOLDER=${env.WORKER_PLACEHOLDER}`
  );

  if (env.RUN_PRINT_QUEUE_WORKER && env.RUN_SYNC_SCHEDULER) {
    throw new Error(
      'Print Queue consumption requires a dedicated worker: set RUN_SYNC_SCHEDULER=false.',
    );
  }

  await assertRuntimeSchemaReady();
  console.log('[worker] migration-owned schema ready');

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
    // PS-430: publish the dedicated role before pg-boss can claim work, so the
    // first claim and its last-success/last-error are never written under the
    // disabled role during startup.
    await setWorkerMode('print-worker');
    startKeepAliveHeartbeat();
    await startPrintQueueWorker();
  }

  if (env.RUN_SYNC_SCHEDULER) {
    // Audit 3.2: the worker is the sole scheduler owner. The watchdog stays
    // process-local by design, while all work cadence is durable in pg-boss.
    console.log('[worker] starting durable pg-boss sync scheduler');
    await startQueuedSyncScheduler();
    stopSyncWatchdog = startSyncStalenessWatchdog();
  } else {
    if (env.RUN_PRINT_QUEUE_WORKER) {
      console.log('[worker] RUN_SYNC_SCHEDULER=false; print queue worker running');
    } else {
      console.log('[worker] RUN_SYNC_SCHEDULER=false; worker is idle');
      await setWorkerMode('disabled');
    }
    startKeepAliveHeartbeat();
  }
}

void main().catch((err) => {
  console.error(
    '[worker] startup failed; exiting unhealthy so the supervisor can restart:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
