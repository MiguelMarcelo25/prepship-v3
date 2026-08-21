import { env } from '../lib/env';
import { sql as pg } from '../db/client';
// PS-457: cents round through the ONE owner, not a local Math.round(x * 100) / 100.
import { roundMoney } from '../lib/money';
import { syncShopifyOrders } from './shopify-order-sync';
import { runDurableRateBackfillJob } from './rates-backfill';
import { buildCadenceRateBackfillJobPayload } from './rate-backfill-job-types';
import { reapStaleOrderRateJobs } from './shipping-workflow/reap-stale-rate-jobs';
import {
  importSkusFromOrders,
  syncShipStationProducts,
} from './inventory-enrichment';
import {
  enqueueMissingShipmentConfirmations,
  processFulfillmentOutboxOnce,
} from './fulfillment/outbox';
import { enqueueMissingInventoryDeductions } from './fulfillment/inventory-deduction-outbox';
import { refreshReportingMetrics } from './reporting-metrics';
import { runExternalShippedReconcile } from '../../scripts/reconcile-external-shipped-orders';
import { runShipmentTrackingPollOnce } from './shipment-tracking';
import { syncWalmartFeesAllAccounts } from '../connectors/store/walmart-fees';
import {
  enqueueStrandedReplacementCancellationCleanup,
  processReplacementFinancialActionsOnce,
} from './replacement-financial-action';

// Audit 3.2: handler-only module. Durable cadence and cross-process admission
// live in sync-job-queue.ts/pg-boss; this file must not start process-local work timers.

const EXTERNAL_SHIPPED_CLASSIFIER_LIMIT = 10;
const EXTERNAL_SHIPPED_CLASSIFIER_LOOKUP_TIMEOUT_MS = 12_000;
const EXTERNAL_SHIPPED_CLASSIFIER_TIME_BUDGET_MS = 4 * 60_000;

// Serialize handler invocations so manual and queued callers cannot overlap.
let shopifyOrderSyncRunning = false;
let inventoryImportRunning = false;
let syncProductsRunning = false;
let fulfillmentOutboxRunning = false;
// Per user override unlock shipped data on 2026-07-18: one durable
// marketplace-confirmation operation can use its full two-minute provider
// timeout. Claim one per shared-lane tick so order refresh regains the lane
// inside its three-minute freshness budget; the minute cadence drains more.
export const FULFILLMENT_OUTBOX_BATCH_LIMIT = 1;
let reportingRefreshRunning = false;
let externalShippedClassifierRunning = false;
let shipmentTrackingRunning = false;
let walmartFeesRunning = false;

// Per user override unlock shipped data on 2026-07-14: pg-boss plus
// withSyncLaneAdvisoryLock in sync-job-queue.ts is the sole admission owner.
// Do not reserve the shared DB pool here: production supports DB_POOL_MAX=1,
// and a handler that reserves that connection deadlocks on its first DB query.
async function runSchedulerJob<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const elapsedMs = Date.now() - startedAt;
    console.log(`[scheduler] ${name} finished in ${elapsedMs}ms`);
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
    const result = await runSchedulerJob('Shopify orders sync', () => syncShopifyOrders(signal));
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

export async function runBackfillTick(
  queueJobId: string,
  signal?: AbortSignal,
): Promise<void> {
  // PS-436: a cron row is only a wake-up. The durable backfill owner converts
  // it into (or joins) one persisted generation and runs exactly one bounded
  // chunk before releasing the shared ShipStation lane.
  const payload = buildCadenceRateBackfillJobPayload(queueJobId);
  const job = await runDurableRateBackfillJob(payload, signal);
  console.log(
    job
      ? `[scheduler] rate backfill chunk finished (generation ${payload.generationId}, ${job.processed}/${job.total})`
      : '[scheduler] rate backfill cadence coalesced into the active durable generation',
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
    const result = await runSchedulerJob('inventory import-from-orders', () => importSkusFromOrders());
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
export async function runSyncProductsTick(signal?: AbortSignal): Promise<void> {
  if (syncProductsRunning) {
    console.log('[scheduler] inventory sync-products already running — skipping tick');
    return;
  }
  syncProductsRunning = true;
  try {
    const result = await runSchedulerJob('inventory sync-products', () =>
      syncShipStationProducts({ signal }),
    );
    if (!result) return;
    console.log(
      `[scheduler] inventory sync-products: ${result.inserted} new + ${result.updated} updated across ${Object.keys(result.byAccount).length} account(s); ` +
      `pages=${result.pages}, deferredAccounts=${result.deferredAccounts}, errors=${result.errors.length}`
    );
  } catch (err) {
    if (signal?.aborted) throw err;
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
    const result = await runSchedulerJob('fulfillment outbox', async () => {
      // Drain already-authorized AC-13 obligations first and isolate the lane. A persistent
      // confirmation/inventory/outbox failure must not prevent this owner from running on
      // every tick, and a financial-lane infrastructure error must not starve those owners.
      let replacementFinancials = { schemaReady: false, processed: 0, succeeded: 0, failed: 0 };
      try {
        replacementFinancials = await processReplacementFinancialActionsOnce({ limit: 5 });
      } catch (error) {
        console.error(
          '[scheduler] replacement financial action drain failed:',
          error instanceof Error ? error.message : error,
        );
      }
      const recoveryResult = await enqueueMissingShipmentConfirmations({ limit: 25 });
      // Per user override unlock shipped data on 2026-07-14: repair missing
      // deduction intent only; execution remains in the kill-switched owner.
      const inventoryRecovered = await enqueueMissingInventoryDeductions(100);
      const outboxResult = await processFulfillmentOutboxOnce({
        limit: FULFILLMENT_OUTBOX_BATCH_LIMIT,
      });
      // Per user override `unlock shipped data` on 2026-08-19: flags-off must never discover
      // and mutate historical replacement money implicitly. Already-durable actions are
      // different: each was explicitly authorized and committed before its side effects, so
      // the retry guarantee survives an HTTP-surface rollback instead of abandoning money
      // halfway through. REPLACEMENTS_LABEL_ENABLED remains the separate provider fence.
      const replacementCleanupRecovered = env.REPLACEMENTS_ENABLED
        ? await enqueueStrandedReplacementCancellationCleanup({ limit: 25 })
        : { schemaReady: false, enqueued: 0 };
      return {
        ...outboxResult,
        autoRecovered: recoveryResult,
        inventoryRecovered,
        replacementCleanupRecovered,
        replacementFinancials,
      };
    });
    if (!result) return;
    if (
      result.autoRecovered.enqueued > 0
      || result.inventoryRecovered > 0
      || result.processed > 0
      || result.replacementCleanupRecovered.enqueued > 0
      || result.replacementFinancials.processed > 0
    ) {
      console.log(
        `[scheduler] fulfillment outbox: ${result.succeeded} succeeded, ${result.failed} failed, ` +
        `${result.processed} processed, ${result.autoRecovered.enqueued} confirmations recovered, ` +
        `${result.inventoryRecovered} inventory events recovered, ` +
        `${result.replacementCleanupRecovered.enqueued} replacement cleanups recovered, ` +
        `${result.replacementFinancials.succeeded}/${result.replacementFinancials.processed} ` +
        'replacement financial actions completed'
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
    const result = await runSchedulerJob('reporting metrics refresh', () =>
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
    const result = await runSchedulerJob(
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
    const result = await runSchedulerJob('shipment tracking poll', () =>
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
    const result = await runSchedulerJob('walmart fees sync', async () => {
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
      totals.totalFeesUsd = roundMoney(totals.totalFeesUsd);
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
