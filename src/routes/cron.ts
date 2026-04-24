import { Hono, type Context } from 'hono';
import { env } from '../lib/env';
import { syncOrders } from '../services/order-sync';
import { syncShipments } from '../services/shipment-sync';
import { startBackfillBestRates } from '../services/rates-backfill';

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
async function parseSyncBody(c: Context): Promise<{ sinceMs?: number }> {
  try {
    const body = await c.req.json().catch(() => null);
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

export default app;
