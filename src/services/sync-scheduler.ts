import { env } from '../lib/env';
import { sql as pg } from '../db/client';
import { syncShopifyOrders } from './shopify-order-sync';
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
import {
  getSyncJobLaneBlocker,
  syncJobLaneFor,
  type SyncJobLane,
} from './sync-job-lanes';

// Legacy interval scheduler for ancillary jobs. PS-417 moved ShipStation
// order/shipment execution to the pg-boss worker lane; this module no longer
// starts provider-import timers.

const SHOPIFY_ORDER_SYNC_INTERVAL_MS = 3 * 60 * 1000;
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
const EXTERNAL_SHIPPED_CLASSIFIER_INTERVAL_MS = SYNC_CADENCE_MS.externalShippedClassifier; // 3 minutes
const SHIPMENT_TRACKING_INTERVAL_MS = SYNC_CADENCE_MS.shipmentTracking; // 15 minutes
const WALMART_FEES_INTERVAL_MS = SYNC_CADENCE_MS.walmartFees; // daily (legacy Vercel cron parity)
const STARTUP_DELAY_MS = 15 * 1000; // 15s after boot so we don't fight cold-start
const EXTERNAL_SHIPPED_CLASSIFIER_LIMIT = 10;
const EXTERNAL_SHIPPED_CLASSIFIER_LOOKUP_TIMEOUT_MS = 12_000;
const EXTERNAL_SHIPPED_CLASSIFIER_TIME_BUDGET_MS = 4 * 60_000;
const REAP_RATE_JOBS_INTERVAL_MS = 5 * 60 * 1000; // 5 min — durable cleanup of orphaned rate-job stamps

// Serialize runs so overlapping intervals don't pile up ShipStation calls.
let shopifyOrderSyncRunning = false;
let inventoryImportRunning = false;
let syncProductsRunning = false;
let fulfillmentOutboxRunning = false;
let reportingRefreshRunning = false;
let externalShippedClassifierRunning = false;
let shipmentTrackingRunning = false;
let walmartFeesRunning = false;
const activeSchedulerJobsByLane = new Map<SyncJobLane, string>();
let shopifyOrderTimer: NodeJS.Timeout | null = null;
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
  const lane = syncJobLaneFor(name);
  const blockedBy = getSyncJobLaneBlocker(activeSchedulerJobsByLane, name);
  if (blockedBy) {
    console.log(
      `[scheduler] ${name} skipped - ${blockedBy} is still running in ${lane} lane`
    );
    await recordWorkerJobSkipped(
      name,
      `${blockedBy} is still running in ${lane} lane`
    );
    return null;
  }
  activeSchedulerJobsByLane.set(lane, name);
  try {
    return await withSchedulerAdvisoryLock(name, async () => {
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
      }
    });
  } finally {
    if (activeSchedulerJobsByLane.get(lane) === name) {
      activeSchedulerJobsByLane.delete(lane);
    }
  }
}

// Audit SY-3 (2026-07-13): optional signal threads the pg-boss deadline into the
// page walk (queued mode passes it; the legacy interval scheduler passes none).
export async function runShopifyOrderSyncTick(signal?: AbortSignal): Promise<void> {
  if (!env.SHOPIFY_SYNC_ENABLED) return;
  if (shopifyOrderSyncRunning) {
    console.log('[scheduler] Shopify orders sync already running - skipping tick');
    return;
  }
  shopifyOrderSyncRunning = true;
  try {
    const result = await runHeavySchedulerJob('Shopify orders sync', () => syncShopifyOrders(signal));
    if (!result?.enabled) return;
    console.log(
      `[scheduler] Shopify orders synced: accounts=${result.accounts}, rows=${result.synced}, errors=${result.errors}`
    );
  } catch (err) {
    console.error(
      '[scheduler] Shopify orders sync failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    shopifyOrderSyncRunning = false;
  }
}

export function runBackfillTick(): void {
  // startBackfillBestRates is already idempotent (activeJobId guard).
  // Just trigger it — if a job is running we'll be a no-op. PS-348 keeps this as a
  // cache-friendly backend refresh of visible tuples before proof expiry, never manual force-live.
  const active = getActiveBackfillJob();
  if (active && active.status === 'running') {
    console.log(
      `[scheduler] rate backfill already running (job ${active.jobId}, ${active.processed}/${active.total}) — skipping tick`
    );
    return;
  }
  const job = startBackfillBestRates({ mode: 'preexpiry_refresh' });
  console.log(
    `[scheduler] rate backfill kicked off (job ${job.jobId}) — stale, missing, or near-expiry rate tuples will be refreshed`
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

// Audit R-8 (2026-07-13): rate caches had NO row lifecycle — the identity key
// embeds the ship-date bucket, so every tuple mints a NEW row each day and
// yesterday's rows are never read again, growing unbounded (37 MB rate_cache +
// 103 MB direct_carrier_rate_cache at audit time; the 2026-07-13 DB disk event
// is the failure mode this feeds). Delete rows older than 3 days (>= 2x the 24h
// TTL, preserving negative-cache semantics). Cheap DELETEs on small tables;
// piggybacks the 5-min reap cadence, no new timer state.
export async function runRateCacheEvictionTick(): Promise<void> {
  try {
    const evicted = await pg`
      DELETE FROM rate_cache WHERE fetched_at < now() - interval '3 days'
    `;
    const evictedDirect = await pg`
      DELETE FROM direct_carrier_rate_cache WHERE updated_at < now() - interval '3 days'
    `;
    if ((evicted.count ?? 0) > 0 || (evictedDirect.count ?? 0) > 0) {
      console.log(
        `[scheduler] evicted expired rate cache rows: rate_cache=${evicted.count ?? 0} direct_carrier_rate_cache=${evictedDirect.count ?? 0}`
      );
    }
  } catch (err) {
    console.warn(
      '[scheduler] rate cache eviction failed:',
      err instanceof Error ? err.message : err
    );
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
    const result = await runHeavySchedulerJob(
      'external-shipped classifier',
      runExternalShippedClassifierJob,
    );
    if (!result) return;
    console.log(
      `[scheduler] external-shipped classifier: missingLocalUnflagged=${result.missingLocalUnflagged}, ` +
      `alreadyFlaggedExternal=${result.alreadyFlaggedExternal}, external=${result.classifiedExternal}, ` +
      `recoverable=${result.classifiedRecoverable}, lookupFailures=${result.lookupFailures}, flagged=${result.flagged}, ` +
      `timeBudgetExhausted=${result.timeBudgetExhausted}`
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

export function runExternalShippedClassifierJob() {
  return runExternalShippedReconcile({
    // Per user override unlock shipped data on 2026-06-27: use the
    // configured 30+ day lookback so automatic shipped/cancelled
    // classification covers the visible Orders table window.
    days: env.EXTERNAL_SHIPPED_CLASSIFIER_LOOKBACK_DAYS,
    // Per user override unlock shipped data on 2026-07-02: run small,
    // bounded batches often so marketplace-shipped rows clear from the
    // yellow "Shipment sync error" state without timing out the worker.
    limit: EXTERNAL_SHIPPED_CLASSIFIER_LIMIT,
    lookupTimeoutMs: EXTERNAL_SHIPPED_CLASSIFIER_LOOKUP_TIMEOUT_MS,
    timeBudgetMs: EXTERNAL_SHIPPED_CLASSIFIER_TIME_BUDGET_MS,
    includeCancelled: true,
    // Per user override unlock shipped data on 2026-06-01: PS-056 scheduled
    // apply is reversible-flag-only and requires this explicit Render env.
    apply: env.ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY === true,
  });
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

  if (!shopifyOrderTimer) {
    if (env.SHOPIFY_SYNC_ENABLED) {
      console.log(
        `[scheduler] Shopify direct store sync enabled - every ${SHOPIFY_ORDER_SYNC_INTERVAL_MS / 1000}s`
      );
      setTimeout(() => {
        void runShopifyOrderSyncTick();
        shopifyOrderTimer = setInterval(
          () => void runShopifyOrderSyncTick(),
          SHOPIFY_ORDER_SYNC_INTERVAL_MS
        );
      }, STARTUP_DELAY_MS + 45_000);
    } else {
      console.log(
        '[scheduler] Shopify direct store sync disabled via SHOPIFY_SYNC_ENABLED=false'
      );
    }
  }

  // ShipStation-backed ancillary jobs still need the main credentials. The
  // pg-boss order/shipment lane is independent and may use per-client creds.
  if (!env.SHIPSTATION_API_KEY || !env.SHIPSTATION_API_SECRET) {
    console.log(
      '[scheduler] SHIPSTATION_API_KEY/SECRET not set; ShipStation ancillary jobs disabled'
    );
    return;
  }

  // PS-417: this legacy scheduler owns ancillary jobs only. ShipStation order
  // and shipment execution is exclusively owned by the pg-boss worker lane;
  // enqueue cadence must not be confused with a completed provider sync.
  console.log('[scheduler] ShipStation imports delegated to the pg-boss sync lane');

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
    void runRateCacheEvictionTick(); // audit R-8: cache lifecycle rides the same cadence
    reapRateJobsTimer = setInterval(
      () => {
        void runReapStaleRateJobsTick();
        void runRateCacheEvictionTick();
      },
      REAP_RATE_JOBS_INTERVAL_MS
    );
  }, STARTUP_DELAY_MS + 60 * 1000); // 1 min after boot
}

export function stopSyncScheduler(): void {
  if (shopifyOrderTimer) {
    clearInterval(shopifyOrderTimer);
    shopifyOrderTimer = null;
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
