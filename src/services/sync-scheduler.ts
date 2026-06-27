import { env } from '../lib/env';
import { sql as pg } from '../db/client';
import { syncOrders } from './order-sync';
import { syncShipments } from './shipment-sync';
import { startBackfillBestRates, getActiveBackfillJob } from './rates-backfill';
import { reapStaleOrderRateJobs } from './shipping-workflow/reap-stale-rate-jobs';
import {
  importSkusFromOrders,
  syncShipStationProducts,
} from './inventory-enrichment';
import {
  enqueueMissingShipmentConfirmations,
  processFulfillmentOutboxOnce,
} from './fulfillment/outbox';
import {
  recordWorkerHeartbeat,
  recordWorkerJobFailure,
  recordWorkerJobSkipped,
  recordWorkerJobStart,
  recordWorkerJobSuccess,
  setWorkerMode,
} from './worker-status';
import { startSyncStalenessWatchdog } from './sync-staleness-watchdog';
import { refreshReportingMetrics } from './reporting-metrics';
import { runExternalShippedReconcile } from '../../scripts/reconcile-external-shipped-orders';
import { runShipmentTrackingPollOnce } from './shipment-tracking';
import { syncWalmartFeesAllAccounts } from '../connectors/store/walmart-fees';
import { SYNC_CADENCE_MS } from '../lib/sync-cadence';

// v2 ran an in-process worker every 3 minutes for orders + shipments. GitHub
// Actions cron drifts 30–60 min under load, which means users in v4 see stale
// data — an order shipped in ShipStation can take 40+ min to flip to Shipped.
// This scheduler restores v2's 3-minute cadence inside the API process itself.
// When Render spins the container down (free-tier idle), the scheduler pauses
// with it — but GitHub Actions' slower cron is still there as a safety net.

const ORDER_SYNC_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes (v2 parity)
const SHIPMENT_SYNC_INTERVAL_MS = 3 * 60 * 1000;
// Rate backfill is expensive (one ShipStation call per order) so fire it
// less often. maxAgeHours inside the service keeps it cheap — orders with
// a fresh rate are skipped automatically.
const RATE_BACKFILL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
// Inventory enrichment cadence — cheap SQL-only scan vs heavy ShipStation
// product-catalog pulls. The user's "no img" pain comes from new SKUs
// landing in orders before the manual import button gets clicked, so we
// run the orders → inventory seed often (every 30 min) and the heavier
// ShipStation /products pull less often (every 60 min). Image columns
// are coalesce-protected on both paths, so re-running is safe even when
// upstream returns null.
const INVENTORY_IMPORT_FROM_ORDERS_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const INVENTORY_SYNC_PRODUCTS_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const FULFILLMENT_OUTBOX_INTERVAL_MS = 60 * 1000; // 1 minute
const REPORTING_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const EXTERNAL_SHIPPED_CLASSIFIER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const SHIPMENT_TRACKING_INTERVAL_MS = SYNC_CADENCE_MS.shipmentTracking; // 15 minutes
const WALMART_FEES_INTERVAL_MS = SYNC_CADENCE_MS.walmartFees; // daily (legacy Vercel cron parity)
const STARTUP_DELAY_MS = 15 * 1000; // 15s after boot so we don't fight cold-start
const REAP_RATE_JOBS_INTERVAL_MS = 5 * 60 * 1000; // 5 min — durable cleanup of orphaned rate-job stamps

// Serialize runs so overlapping intervals don't pile up ShipStation calls.
let orderSyncRunning = false;
let shipmentSyncRunning = false;
let inventoryImportRunning = false;
let syncProductsRunning = false;
let fulfillmentOutboxRunning = false;
let reportingRefreshRunning = false;
let externalShippedClassifierRunning = false;
let shipmentTrackingRunning = false;
let walmartFeesRunning = false;
let heavySchedulerJobRunning: string | null = null;
let orderTimer: NodeJS.Timeout | null = null;
let shipmentTimer: NodeJS.Timeout | null = null;
let backfillTimer: NodeJS.Timeout | null = null;
let inventoryImportTimer: NodeJS.Timeout | null = null;
let syncProductsTimer: NodeJS.Timeout | null = null;
let fulfillmentOutboxTimer: NodeJS.Timeout | null = null;
let reportingRefreshTimer: NodeJS.Timeout | null = null;
let externalShippedClassifierTimer: NodeJS.Timeout | null = null;
let shipmentTrackingTimer: NodeJS.Timeout | null = null;
let walmartFeesTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reapRateJobsTimer: NodeJS.Timeout | null = null;

async function withSchedulerAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lockName = `prepship.scheduler.${name}`;
  const reserved = await pg.reserve();
  try {
    const [row] = await reserved<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(hashtext(${lockName})) as acquired
    `;
    if (!row?.acquired) {
      console.log(`[scheduler] ${name} skipped - another process holds the scheduler lock`);
      await recordWorkerJobSkipped(name, 'scheduler lock held by another process');
      return null;
    }
    try {
      return await fn();
    } finally {
      await reserved`select pg_advisory_unlock(hashtext(${lockName}))`;
    }
  } finally {
    reserved.release();
  }
}

function isRateBackfillSchedulerEnabled(): boolean {
  return env.ENABLE_RATE_BACKFILL_SCHEDULER && !env.DISABLE_RATE_BACKFILL_SCHEDULER;
}

async function runHeavySchedulerJob<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (heavySchedulerJobRunning) {
    console.log(
      `[scheduler] ${name} skipped - ${heavySchedulerJobRunning} is still running`
    );
    await recordWorkerJobSkipped(
      name,
      `${heavySchedulerJobRunning} is still running`
    );
    return null;
  }
  return withSchedulerAdvisoryLock(name, async () => {
    heavySchedulerJobRunning = name;
    const startedAt = Date.now();
    await recordWorkerJobStart(name);
    try {
      const result = await fn();
      await recordWorkerJobSuccess(name, startedAt, result);
      return result;
    } catch (err) {
      await recordWorkerJobFailure(name, startedAt, err);
      throw err;
    } finally {
      const elapsedMs = Date.now() - startedAt;
      console.log(`[scheduler] ${name} finished in ${elapsedMs}ms`);
      heavySchedulerJobRunning = null;
    }
  });
}

export async function runOrderSync(): Promise<void> {
  if (orderSyncRunning) {
    console.log('[scheduler] orders sync already running — skipping tick');
    return;
  }
  orderSyncRunning = true;
  try {
    const result = await runHeavySchedulerJob('orders sync', () => syncOrders({}));
    if (!result) return;
    console.log(
      `[scheduler] orders synced: ${result.synced} rows in ${result.pages} page(s), watermark ${result.lastSyncedAt}`
    );
    if (result.synced > 0 && isRateBackfillSchedulerEnabled()) {
      runBackfillTick();
    }
  } catch (err) {
    console.error(
      '[scheduler] orders sync failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    orderSyncRunning = false;
  }
}

export function runBackfillTick(): void {
  // startBackfillBestRates is already idempotent (activeJobId guard).
  // Just trigger it — if a job is running we'll be a no-op.
  const active = getActiveBackfillJob();
  if (active && active.status === 'running') {
    console.log(
      `[scheduler] rate backfill already running (job ${active.jobId}, ${active.processed}/${active.total}) — skipping tick`
    );
    return;
  }
  const job = startBackfillBestRates({});
  console.log(
    `[scheduler] rate backfill kicked off (job ${job.jobId}) — only orders with stale/no rates will be fetched`
  );
}

// PS-120 leak fix: durable, age-based cleanup of orphaned order_rate_jobs stamps. A worker crash /
// Render redeploy mid-rating leaves pending/rating rows the in-memory clearOrderRateJob never reaches;
// this reaps them by the clock so they can't pile up. Cheap single DELETE, idempotent, never throws.
export async function runReapStaleRateJobsTick(): Promise<void> {
  try {
    const reaped = await reapStaleOrderRateJobs();
    if (reaped > 0) {
      console.log(`[scheduler] reaped ${reaped} stale order_rate_jobs (orphaned pending/rating stamps)`);
    }
  } catch (err) {
    console.warn(
      '[scheduler] reap stale rate jobs failed:',
      err instanceof Error ? err.message : err
    );
  }
}

export async function runShipmentSync(): Promise<void> {
  if (shipmentSyncRunning) {
    console.log('[scheduler] shipments sync already running — skipping tick');
    return;
  }
  shipmentSyncRunning = true;
  try {
    const result = await runHeavySchedulerJob('shipments sync', () => syncShipments({}));
    if (!result) return;
    console.log(
      `[scheduler] shipments synced: ${result.inserted} new + ${result.updated} updated, ${result.ordersMarkedShipped} orders marked shipped`
    );
  } catch (err) {
    console.error(
      '[scheduler] shipments sync failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    shipmentSyncRunning = false;
  }
}

// 2026-05-13: orders → inventory seed. Cheap (one SQL query plus
// per-row upserts), bottlenecked on row count not network — fine to
// run every 30 min. Picks up new SKUs as soon as orders carrying them
// land via the 3-min order sync. Back-fills image_url / name on
// existing rows where the column was NULL. Coalesce protects any
// operator-set values.
export async function runInventoryImportFromOrders(): Promise<void> {
  if (inventoryImportRunning) {
    console.log('[scheduler] inventory import-from-orders already running — skipping tick');
    return;
  }
  inventoryImportRunning = true;
  try {
    const result = await runHeavySchedulerJob('inventory import-from-orders', () => importSkusFromOrders());
    if (!result) return;
    console.log(
      `[scheduler] inventory import-from-orders: ${result.inserted} new SKU(s), ${result.skipped} already existed`
    );
  } catch (err) {
    console.error(
      '[scheduler] inventory import-from-orders failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    inventoryImportRunning = false;
  }
}

// 2026-05-13: ShipStation /products catalog pull. Heavier — paginates
// at 500/page across every active ShipStation account (main env +
// per-client creds). Runs hourly. Updates weight / L / W / H / image
// columns. Images use SS thumbnailUrl with fallback to imageUrl, and
// only overwrite when SS actually returned a value (so a null SS
// response doesn't destroy a URL we already extracted from an order
// item).
export async function runSyncProductsTick(): Promise<void> {
  if (syncProductsRunning) {
    console.log('[scheduler] inventory sync-products already running — skipping tick');
    return;
  }
  syncProductsRunning = true;
  try {
    const result = await runHeavySchedulerJob('inventory sync-products', () => syncShipStationProducts());
    if (!result) return;
    console.log(
      `[scheduler] inventory sync-products: ${result.inserted} new + ${result.updated} updated across ${Object.keys(result.byAccount).length} account(s)`
    );
  } catch (err) {
    console.error(
      '[scheduler] inventory sync-products failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    syncProductsRunning = false;
  }
}

export async function runFulfillmentOutboxTick(): Promise<void> {
  if (fulfillmentOutboxRunning) {
    console.log('[scheduler] fulfillment outbox already running - skipping tick');
    return;
  }
  fulfillmentOutboxRunning = true;
  try {
    const result = await withSchedulerAdvisoryLock('fulfillment outbox', async () => {
      const startedAt = Date.now();
      await recordWorkerJobStart('fulfillment outbox');
      try {
        const recoveryResult = await enqueueMissingShipmentConfirmations({ limit: 25 });
        const outboxResult = await processFulfillmentOutboxOnce({ limit: 25 });
        const combinedResult = { ...outboxResult, autoRecovered: recoveryResult };
        await recordWorkerJobSuccess('fulfillment outbox', startedAt, combinedResult);
        return combinedResult;
      } catch (err) {
        await recordWorkerJobFailure('fulfillment outbox', startedAt, err);
        throw err;
      }
    });
    if (!result) return;
    if (result.autoRecovered.enqueued > 0 || result.processed > 0) {
      console.log(
        `[scheduler] fulfillment outbox: ${result.succeeded} succeeded, ${result.failed} failed, ` +
        `${result.processed} processed, ${result.autoRecovered.enqueued} auto-recovered`
      );
    }
  } catch (err) {
    console.error(
      '[scheduler] fulfillment outbox failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    fulfillmentOutboxRunning = false;
  }
}

export async function runReportingRefreshTick(): Promise<void> {
  if (reportingRefreshRunning) {
    console.log('[scheduler] reporting refresh already running - skipping tick');
    return;
  }
  reportingRefreshRunning = true;
  try {
    const result = await runHeavySchedulerJob('reporting metrics refresh', () =>
      refreshReportingMetrics({ days: 45, inventoryLimit: 2000 })
    );
    if (!result) return;
    console.log(
      `[scheduler] reporting metrics refreshed: daily=${result.dailyRows}, sku=${result.skuRows}, inventory=${result.inventoryRows}, billing=${result.billingRows}`
    );
  } catch (err) {
    console.error(
      '[scheduler] reporting metrics refresh failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    reportingRefreshRunning = false;
  }
}

export async function runExternalShippedClassifierTick(): Promise<void> {
  if (externalShippedClassifierRunning) {
    console.log('[scheduler] external-shipped classifier already running - skipping tick');
    return;
  }
  externalShippedClassifierRunning = true;
  try {
    const result = await runHeavySchedulerJob('external-shipped classifier', () =>
      runExternalShippedReconcile({
        // Per user override unlock shipped data on 2026-06-27: use the
        // configured 30+ day lookback so automatic shipped/cancelled
        // classification covers the visible Orders table window.
        days: env.EXTERNAL_SHIPPED_CLASSIFIER_LOOKBACK_DAYS,
        limit: 50,
        includeCancelled: true,
        // Per user override unlock shipped data on 2026-06-01: PS-056 scheduled
        // apply is reversible-flag-only and requires this explicit Render env.
        apply: env.ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY === true,
      })
    );
    if (!result) return;
    console.log(
      `[scheduler] external-shipped classifier: missingLocalUnflagged=${result.missingLocalUnflagged}, ` +
      `alreadyFlaggedExternal=${result.alreadyFlaggedExternal}, external=${result.classifiedExternal}, ` +
      `recoverable=${result.classifiedRecoverable}, lookupFailures=${result.lookupFailures}, flagged=${result.flagged}`
    );
  } catch (err) {
    console.error(
      '[scheduler] external-shipped classifier failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    externalShippedClassifierRunning = false;
  }
}

export async function runShipmentTrackingTick(): Promise<void> {
  if (shipmentTrackingRunning) {
    console.log('[scheduler] shipment tracking poll already running - skipping tick');
    return;
  }
  shipmentTrackingRunning = true;
  try {
    const result = await runHeavySchedulerJob('shipment tracking poll', () =>
      runShipmentTrackingPollOnce({
        // Tracking-driven print-queue retirement: observe-only unless the
        // operator explicitly enables auto-retire (the instant kill-switch).
        autoRetire: env.TRACKING_AUTO_RETIRE_ENABLED === true,
      })
    );
    if (!result) return;
    console.log(
      `[scheduler] shipment tracking: candidates=${result.candidates}, checked=${result.checked}, ` +
      `delivered=${result.delivered}, retired=${result.retired}, unknown=${result.unknown}, errors=${result.errors}`
    );
  } catch (err) {
    console.error(
      '[scheduler] shipment tracking poll failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    shipmentTrackingRunning = false;
  }
}

// PS-200 S3: daily Walmart selling-fee sync, relocated from the legacy
// Vercel cron (api/cron/sync-walmart-fees.ts, 09:00 UTC). Same window (14
// days) and the same connector-owned sync (src/connectors/store/
// walmart-fees.ts); only the scheduler moved. Uses the shared pg client —
// this is a long-lived process, not a serverless function.
export async function runWalmartFeesTick(): Promise<void> {
  if (walmartFeesRunning) {
    console.log('[scheduler] walmart fees sync already running - skipping tick');
    return;
  }
  walmartFeesRunning = true;
  try {
    const result = await runHeavySchedulerJob('walmart fees sync', async () => {
      const days = 14;
      const now = new Date();
      const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const toDate = now.toISOString().slice(0, 10);
      const accountResults = await syncWalmartFeesAllAccounts(pg, fromDate, toDate);
      const totals = { accounts: accountResults.length, fetched: 0, ordersUpdated: 0, ordersMissing: 0, totalFeesUsd: 0, errors: 0 };
      for (const r of accountResults) {
        if (r.ok) {
          totals.fetched += r.fetched ?? 0;
          totals.ordersUpdated += r.ordersUpdated ?? 0;
          totals.ordersMissing += r.ordersMissing ?? 0;
          totals.totalFeesUsd += r.totalFeesUsd ?? 0;
        } else {
          totals.errors += 1;
        }
      }
      totals.totalFeesUsd = Math.round(totals.totalFeesUsd * 100) / 100;
      return totals;
    });
    if (!result) return;
    console.log(
      `[scheduler] walmart fees sync: accounts=${result.accounts}, fetched=${result.fetched}, ` +
      `ordersUpdated=${result.ordersUpdated}, ordersMissing=${result.ordersMissing}, ` +
      `feesUsd=${result.totalFeesUsd}, errors=${result.errors}`
    );
  } catch (err) {
    console.error(
      '[scheduler] walmart fees sync failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    walmartFeesRunning = false;
  }
}

export function startSyncScheduler(
  options: { mode?: 'api-scheduler' | 'worker-scheduler' } = {}
): void {
  const mode = options.mode ?? 'api-scheduler';
  void setWorkerMode(mode);
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      void recordWorkerHeartbeat();
    }, 30_000);
  }
  // PS-265 (secondary): active staleness watchdog. Complements PS-265 core's withDeadline
  // self-heal by NOTICING a stale heartbeat or a job held past its deadline — emits a
  // structured `[sync-watchdog]` alert so a wedged sync surfaces without a manual restart.
  startSyncStalenessWatchdog();

  if (!fulfillmentOutboxTimer) {
    console.log(
      `[scheduler] fulfillment outbox enabled - every ${FULFILLMENT_OUTBOX_INTERVAL_MS / 1000}s`
    );
    setTimeout(() => {
      void runFulfillmentOutboxTick();
      fulfillmentOutboxTimer = setInterval(
        () => void runFulfillmentOutboxTick(),
        FULFILLMENT_OUTBOX_INTERVAL_MS
      );
    }, STARTUP_DELAY_MS + 30_000);
  }

  if (!reportingRefreshTimer) {
    console.log(
      `[scheduler] reporting metrics refresh enabled - every ${REPORTING_REFRESH_INTERVAL_MS / 60000}m`
    );
    setTimeout(() => {
      void runReportingRefreshTick();
      reportingRefreshTimer = setInterval(
        () => void runReportingRefreshTick(),
        REPORTING_REFRESH_INTERVAL_MS
      );
    }, STARTUP_DELAY_MS + 4 * 60 * 1000);
  }

  if (!externalShippedClassifierTimer) {
    if (env.ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER) {
      console.log(
        `[scheduler] external-shipped classifier enabled - every ${EXTERNAL_SHIPPED_CLASSIFIER_INTERVAL_MS / 60000}m; ` +
        `autoApply=${env.ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY === true}`
      );
      setTimeout(() => {
        void runExternalShippedClassifierTick();
        externalShippedClassifierTimer = setInterval(
          () => void runExternalShippedClassifierTick(),
          EXTERNAL_SHIPPED_CLASSIFIER_INTERVAL_MS
        );
      }, STARTUP_DELAY_MS + 6 * 60 * 1000);
    } else {
      console.log(
        '[scheduler] external-shipped classifier disabled; set ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER=true to automate PS-056 dry-run/apply'
      );
    }
  }

  if (!shipmentTrackingTimer) {
    if (env.ENABLE_SHIPMENT_TRACKING_SCHEDULER && env.SHIPSTATION_API_KEY_V2) {
      console.log(
        `[scheduler] shipment tracking poll enabled - every ${SHIPMENT_TRACKING_INTERVAL_MS / 60000}m; ` +
        `autoRetire=${env.TRACKING_AUTO_RETIRE_ENABLED === true}`
      );
      setTimeout(() => {
        void runShipmentTrackingTick();
        shipmentTrackingTimer = setInterval(
          () => void runShipmentTrackingTick(),
          SHIPMENT_TRACKING_INTERVAL_MS
        );
      }, STARTUP_DELAY_MS + 7 * 60 * 1000);
    } else {
      console.log(
        '[scheduler] shipment tracking poll disabled; set ENABLE_SHIPMENT_TRACKING_SCHEDULER=true (+ SHIPSTATION_API_KEY_V2) to poll delivery status for queued labels'
      );
    }
  }

  if (!walmartFeesTimer) {
    if (env.ENABLE_WALMART_FEES_SCHEDULER) {
      console.log(
        `[scheduler] walmart fees sync enabled - every ${WALMART_FEES_INTERVAL_MS / 3600000}h (legacy Vercel cron replacement)`
      );
      walmartFeesTimer = setTimeout(() => {
        void runWalmartFeesTick();
        walmartFeesTimer = setInterval(
          () => void runWalmartFeesTick(),
          WALMART_FEES_INTERVAL_MS
        );
      }, STARTUP_DELAY_MS + 9 * 60 * 1000);
    } else {
      console.log(
        '[scheduler] walmart fees sync disabled via ENABLE_WALMART_FEES_SCHEDULER=false'
      );
    }
  }

  // Only run in-process sync when ShipStation credentials are present.
  // Dev environments without creds would just spam errors otherwise.
  if (!env.SHIPSTATION_API_KEY || !env.SHIPSTATION_API_SECRET) {
    console.log(
      '[scheduler] SHIPSTATION_API_KEY/SECRET not set — in-process sync disabled'
    );
    void recordWorkerJobSkipped(
      'orders sync',
      'SHIPSTATION_API_KEY/SECRET not set; order sync disabled'
    );
    void recordWorkerJobSkipped(
      'shipments sync',
      'SHIPSTATION_API_KEY/SECRET not set; shipment sync disabled'
    );
    return;
  }

  if (orderTimer || shipmentTimer) {
    console.warn('[scheduler] already started, ignoring duplicate start');
    return;
  }

  console.log(
    `[scheduler] starting — orders every ${ORDER_SYNC_INTERVAL_MS / 1000}s, shipments every ${SHIPMENT_SYNC_INTERVAL_MS / 1000}s (delayed ${STARTUP_DELAY_MS / 1000}s)`
  );

  // Kick off the first run 15s after boot so the process is warm, then
  // schedule subsequent runs on the interval.
  setTimeout(() => {
    void runOrderSync();
    orderTimer = setInterval(() => void runOrderSync(), ORDER_SYNC_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  // Stagger shipment sync by 90s so we don't hammer ShipStation from both
  // jobs at the exact same moment every 3 minutes.
  setTimeout(() => {
    void runShipmentSync();
    shipmentTimer = setInterval(
      () => void runShipmentSync(),
      SHIPMENT_SYNC_INTERVAL_MS
    );
  }, STARTUP_DELAY_MS + 90_000);

  const rateBackfillEnabled = isRateBackfillSchedulerEnabled();

  if (rateBackfillEnabled) {
    console.log(
      `[scheduler] rate backfill enabled — every ${RATE_BACKFILL_INTERVAL_MS / 1000}s`
    );
    // Rate backfill — fires every 10 min, fetches rates for any awaiting order
    // that has no rate yet OR whose saved rate is past the backend cache TTL.
    // Start 3 min after boot so the first order-sync has time to pull any new
    // orders in before we try to rate them.
    setTimeout(() => {
      runBackfillTick();
      backfillTimer = setInterval(runBackfillTick, RATE_BACKFILL_INTERVAL_MS);
    }, STARTUP_DELAY_MS + 3 * 60 * 1000);
  } else {
    console.log(
      '[scheduler] rate backfill disabled; run /rates/backfill-best manually or set ENABLE_RATE_BACKFILL_SCHEDULER=true'
    );
  }

  // 2026-05-13: inventory enrichment ticks. Both are gated by
  // SHIPSTATION_API_KEY/SECRET being set (the broader scheduler
  // gate above) — without creds the products pull would just fail,
  // and without orders syncing in the first place the from-orders
  // seed would have nothing new to scan.
  //
  // Staggered start so the import-from-orders tick can run first
  // (it's the data source: SKUs appear in orders before they appear
  // in ShipStation /products). Both tick functions are self-
  // serializing via running-flag guards, so overlap is harmless.
  console.log(
    `[scheduler] inventory enrichment enabled — import-from-orders every ${INVENTORY_IMPORT_FROM_ORDERS_INTERVAL_MS / 60000}m, sync-products every ${INVENTORY_SYNC_PRODUCTS_INTERVAL_MS / 60000}m`
  );
  setTimeout(() => {
    void runInventoryImportFromOrders();
    inventoryImportTimer = setInterval(
      () => void runInventoryImportFromOrders(),
      INVENTORY_IMPORT_FROM_ORDERS_INTERVAL_MS
    );
  }, STARTUP_DELAY_MS + 2 * 60 * 1000); // 2 min after boot — let order sync run first

  setTimeout(() => {
    void runSyncProductsTick();
    syncProductsTimer = setInterval(
      () => void runSyncProductsTick(),
      INVENTORY_SYNC_PRODUCTS_INTERVAL_MS
    );
  }, STARTUP_DELAY_MS + 5 * 60 * 1000); // 5 min after boot — let the from-orders seed run first

  // PS-120 leak fix: reap orphaned rate-job stamps on a steady cadence — and once ~1 min after boot,
  // which also collects any stamps orphaned by THIS process's previous crash/redeploy. Runs
  // unconditionally; it's a cheap DB cleanup independent of whether the rate backfill is enabled.
  setTimeout(() => {
    void runReapStaleRateJobsTick();
    reapRateJobsTimer = setInterval(
      () => void runReapStaleRateJobsTick(),
      REAP_RATE_JOBS_INTERVAL_MS
    );
  }, STARTUP_DELAY_MS + 60 * 1000); // 1 min after boot
}

export function stopSyncScheduler(): void {
  if (orderTimer) {
    clearInterval(orderTimer);
    orderTimer = null;
  }
  if (shipmentTimer) {
    clearInterval(shipmentTimer);
    shipmentTimer = null;
  }
  if (backfillTimer) {
    clearInterval(backfillTimer);
    backfillTimer = null;
  }
  if (reapRateJobsTimer) {
    clearInterval(reapRateJobsTimer);
    reapRateJobsTimer = null;
  }
  if (inventoryImportTimer) {
    clearInterval(inventoryImportTimer);
    inventoryImportTimer = null;
  }
  if (syncProductsTimer) {
    clearInterval(syncProductsTimer);
    syncProductsTimer = null;
  }
  if (fulfillmentOutboxTimer) {
    clearInterval(fulfillmentOutboxTimer);
    fulfillmentOutboxTimer = null;
  }
  if (reportingRefreshTimer) {
    clearInterval(reportingRefreshTimer);
    reportingRefreshTimer = null;
  }
  if (externalShippedClassifierTimer) {
    clearInterval(externalShippedClassifierTimer);
    externalShippedClassifierTimer = null;
  }
  if (shipmentTrackingTimer) {
    clearInterval(shipmentTrackingTimer);
    shipmentTrackingTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  void setWorkerMode('disabled');
  console.log('[scheduler] stopped');
}
