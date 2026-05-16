import { env } from './lib/env';
import {
  recordWorkerHeartbeat,
  setWorkerMode,
} from './services/worker-status';
import {
  startSyncScheduler,
  stopSyncScheduler,
} from './services/sync-scheduler';
import { ensureOrdersPerformanceIndexes } from './services/orders-performance-maintenance';

let keepAliveTimer: NodeJS.Timeout | null = null;

function startKeepAliveHeartbeat(): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    void recordWorkerHeartbeat();
  }, 30_000);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`[worker] received ${signal}; shutting down`);
  stopSyncScheduler();
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
    `[worker] RUN_SYNC_SCHEDULER=${env.RUN_SYNC_SCHEDULER}; WORKER_PLACEHOLDER=${env.WORKER_PLACEHOLDER}`
  );

  if (env.WORKER_PLACEHOLDER) {
    console.log('[worker] placeholder mode enabled; sync scheduler is not running');
    await setWorkerMode('placeholder');
    startKeepAliveHeartbeat();
    return;
  }

  const runMaintenance =
    env.RUN_ORDERS_PERFORMANCE_MAINTENANCE ?? env.RUN_SYNC_SCHEDULER;

  if (runMaintenance) {
    console.log('[worker] starting orders performance maintenance');
    ensureOrdersPerformanceIndexes();
  } else {
    console.log('[worker] orders performance maintenance disabled');
  }

  if (env.RUN_SYNC_SCHEDULER) {
    console.log('[worker] starting sync scheduler');
    startSyncScheduler({ mode: 'worker-scheduler' });
  } else {
    console.log('[worker] RUN_SYNC_SCHEDULER=false; worker is idle');
    await setWorkerMode('disabled');
    startKeepAliveHeartbeat();
  }
}

void main();
