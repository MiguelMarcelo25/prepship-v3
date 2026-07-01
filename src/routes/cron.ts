import { Hono, type Context } from 'hono';
import { env } from '../lib/env';
import { syncOrders } from '../services/order-sync';
import { syncShipments } from '../services/shipment-sync';
import { startBackfillBestRates } from '../services/rates-backfill';
import {
  importSkusFromOrders,
  syncShipStationProducts,
} from '../services/inventory-enrichment';
import { processFulfillmentOutboxOnce } from '../services/fulfillment/outbox';
import { runShipmentSyncWatchdogTick } from '../services/shipment-sync-watchdog';

const app = new Hono();

app.use('*', async (c, next) => {
  if (!env.CRON_SECRET) {
    return c.json({ error: 'CRON_SECRET not configured' }, 503);
  }
  const provided = c.req.header('x-cron-secret') ?? '';
  if (provided !== env.CRON_SECRET) {
    return c.json({ error: 'Invalid cron secret' }, 401);
  }
  await next();
});

// Body shape accepted on POST: `{sinceMs?: number, fullResync?: boolean}`.
// fullResync=true sets sinceMs=0 so sync pulls EVERYTHING from ShipStation,
// ignoring the stored watermark. Useful for initial backfill or recovery
// after a sync gap. Matches the same body contract as /orders/sync (the
// JWT-authed equivalent in src/routes/orders.ts).
// PS-232: cap the cron sync body. These endpoints accept only a tiny
// {sinceMs?, fullResync?} payload; reject anything larger before parsing (the
// webhook route already caps its body — mirror that posture here). Oversize ->
// fall through to safe defaults (a normal watermark sync, never a full resync).
const CRON_SYNC_MAX_BODY_BYTES = 64 * 1024;

async function parseSyncBody(c: Context): Promise<{ sinceMs?: number }> {
  try {
    const raw = await c.req.text().catch(() => '');
    if (raw && Buffer.byteLength(raw, 'utf8') > CRON_SYNC_MAX_BODY_BYTES) return {};
    const body = raw ? JSON.parse(raw) : null;
    if (body && typeof body === 'object') {
      if (typeof body.sinceMs === 'number') return { sinceMs: body.sinceMs };
      if (body.fullResync === true) return { sinceMs: 0 };
    }
  } catch {
    // empty / malformed body — fall through to defaults
  }
  return {};
}

app.post('/sync-orders', async (c) => {
  const opts = await parseSyncBody(c);
  const result = await syncOrders(opts);
  const rateBackfillJob =
    result.synced > 0
      ? (() => {
          const job = startBackfillBestRates({ limit: 1000 });
          return { jobId: job.jobId, status: job.status };
        })()
      : null;
  return c.json({ ...result, rateBackfillJob });
});

app.get('/sync-orders', async (c) => {
  const result = await syncOrders({});
  const rateBackfillJob =
    result.synced > 0
      ? (() => {
          const job = startBackfillBestRates({ limit: 1000 });
          return { jobId: job.jobId, status: job.status };
        })()
      : null;
  return c.json({ ...result, rateBackfillJob });
});

app.post('/sync-shipments', async (c) => {
  const opts = await parseSyncBody(c);
  const result = await syncShipments(opts);
  return c.json(result);
});

app.get('/sync-shipments', async (c) => {
  const result = await syncShipments({});
  return c.json(result);
});

// Run both orders + shipments in sequence. Shipments depend on orders being
// present to match by externalOrderId, so always run orders first.
app.post('/sync-all', async (c) => {
  const opts = await parseSyncBody(c);
  const ordersResult = await syncOrders(opts);
  const rateBackfillJob =
    ordersResult.synced > 0
      ? (() => {
          const job = startBackfillBestRates({ limit: 1000 });
          return { jobId: job.jobId, status: job.status };
        })()
      : null;
  const shipmentsResult = await syncShipments(opts);
  return c.json({ orders: ordersResult, shipments: shipmentsResult, rateBackfillJob });
});

// 2026-05-13: inventory enrichment cron endpoints — external scheduler
// safety net for the in-process ticks in sync-scheduler.ts. Both POST
// and GET supported so any cron service (GitHub Actions, cron-job.org,
// Render cron) can hit them with the x-cron-secret header. The
// services are self-serialized only at the in-process level, so an
// external trigger that happens to overlap an in-process tick will
// run normally — both paths use coalesce-protected writes, so the
// worst case is a duplicate scan that produces 0 changes.
app.post('/import-skus-from-orders', async (c) => {
  const result = await importSkusFromOrders();
  return c.json(result);
});

app.get('/import-skus-from-orders', async (c) => {
  const result = await importSkusFromOrders();
  return c.json(result);
});

app.post('/sync-products', async (c) => {
  const result = await syncShipStationProducts();
  return c.json(result);
});

app.get('/sync-products', async (c) => {
  const result = await syncShipStationProducts();
  return c.json(result);
});

app.post('/shipment-sync-watchdog', async (c) => {
  const result = await runShipmentSyncWatchdogTick({ recover: true, source: 'cron' });
  return c.json(result);
});

app.get('/shipment-sync-watchdog', async (c) => {
  const result = await runShipmentSyncWatchdogTick({ recover: true, source: 'cron' });
  return c.json(result);
});

app.post('/fulfillment-outbox', async (c) => {
  const body = await c.req.json().catch(() => null) as { limit?: number } | null;
  const limit = Math.min(Math.max(Number(body?.limit ?? 25) || 25, 1), 100);
  const result = await processFulfillmentOutboxOnce({ limit });
  return c.json(result);
});

app.get('/fulfillment-outbox', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 25) || 25, 1), 100);
  const result = await processFulfillmentOutboxOnce({ limit });
  return c.json(result);
});

export default app;
