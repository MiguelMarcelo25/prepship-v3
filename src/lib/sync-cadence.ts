// PS-132 (old PS-141): single source of truth for the sync/job scheduler cadence.
//
// Both the job queue (src/services/sync-job-queue.ts) and the status endpoint
// (src/routes/sync.ts) read these constants, so the cadence the API REPORTS can never drift
// from the cadence that is actually SCHEDULED. Previously the intervals lived in
// sync-job-queue.ts while the status endpoint hardcoded its own minutes object.

/** Scheduler intervals in milliseconds. */
export const SYNC_CADENCE_MS = {
  orders: 3 * 60 * 1000,
  shipments: 3 * 60 * 1000,
  rateBackfill: 10 * 60 * 1000,
  inventoryFromOrders: 30 * 60 * 1000,
  productCatalog: 60 * 60 * 1000,
  fulfillmentOutbox: 60 * 1000,
  reportingMetrics: 30 * 60 * 1000,
  externalShippedClassifier: 30 * 60 * 1000,
  // Tracking-driven print-queue retirement: ~50 read-only tracking calls per
  // tick is <2% of the ShipStation v2 budget, and a delivery surfaces within
  // one operator shift.
  shipmentTracking: 15 * 60 * 1000,
  // PS-200 S3: daily parity with the legacy Vercel cron (0 9 * * *). The
  // interval anchor resets on deploy, so deploy days can run it more than
  // once — harmless: the sync re-reads a 14-day settlement window and
  // upserts idempotently.
  walmartFees: 24 * 60 * 60 * 1000,
} as const;

/** Delay before the first scheduled enqueue after process start. */
export const SYNC_STARTUP_DELAY_MS = 15 * 1000;

/**
 * Cadence in whole minutes, DERIVED from SYNC_CADENCE_MS — for the status endpoint / UI.
 * Keys mirror the legacy `cadenceMinutes` status payload exactly (orders, shipments,
 * rateBackfill, inventoryFromOrders, productCatalog, reportingMetrics).
 */
export const SYNC_CADENCE_MINUTES = {
  orders: SYNC_CADENCE_MS.orders / 60_000,
  shipments: SYNC_CADENCE_MS.shipments / 60_000,
  rateBackfill: SYNC_CADENCE_MS.rateBackfill / 60_000,
  inventoryFromOrders: SYNC_CADENCE_MS.inventoryFromOrders / 60_000,
  productCatalog: SYNC_CADENCE_MS.productCatalog / 60_000,
  reportingMetrics: SYNC_CADENCE_MS.reportingMetrics / 60_000,
} as const;
