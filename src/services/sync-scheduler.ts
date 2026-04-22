import { env } from '../lib/env';
import { syncOrders } from './order-sync';
import { syncShipments } from './shipment-sync';

// v2 ran an in-process worker every 3 minutes for orders + shipments. GitHub
// Actions cron drifts 30–60 min under load, which means users in v4 see stale
// data — an order shipped in ShipStation can take 40+ min to flip to Shipped.
// This scheduler restores v2's 3-minute cadence inside the API process itself.
// When Render spins the container down (free-tier idle), the scheduler pauses
// with it — but GitHub Actions' slower cron is still there as a safety net.

const ORDER_SYNC_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes (v2 parity)
const SHIPMENT_SYNC_INTERVAL_MS = 3 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000; // 15s after boot so we don't fight cold-start

// Serialize runs so overlapping intervals don't pile up ShipStation calls.
let orderSyncRunning = false;
let shipmentSyncRunning = false;
let orderTimer: NodeJS.Timeout | null = null;
let shipmentTimer: NodeJS.Timeout | null = null;

async function runOrderSync(): Promise<void> {
  if (orderSyncRunning) {
    console.log('[scheduler] orders sync already running — skipping tick');
    return;
  }
  orderSyncRunning = true;
  try {
    const result = await syncOrders({});
    console.log(
      `[scheduler] orders synced: ${result.synced} rows in ${result.pages} page(s), watermark ${result.lastSyncedAt}`
    );
  } catch (err) {
    console.error(
      '[scheduler] orders sync failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    orderSyncRunning = false;
  }
}

async function runShipmentSync(): Promise<void> {
  if (shipmentSyncRunning) {
    console.log('[scheduler] shipments sync already running — skipping tick');
    return;
  }
  shipmentSyncRunning = true;
  try {
    const result = await syncShipments({});
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

export function startSyncScheduler(): void {
  // Only run in-process sync when ShipStation credentials are present.
  // Dev environments without creds would just spam errors otherwise.
  if (!env.SHIPSTATION_API_KEY || !env.SHIPSTATION_API_SECRET) {
    console.log(
      '[scheduler] SHIPSTATION_API_KEY/SECRET not set — in-process sync disabled'
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
  console.log('[scheduler] stopped');
}
