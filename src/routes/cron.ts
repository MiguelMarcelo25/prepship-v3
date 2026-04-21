import { Hono } from 'hono';
import { env } from '../lib/env';
import { syncOrders } from '../services/order-sync';
import { syncShipments } from '../services/shipment-sync';

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

app.post('/sync-orders', async (c) => {
  const result = await syncOrders({});
  return c.json(result);
});

app.get('/sync-orders', async (c) => {
  const result = await syncOrders({});
  return c.json(result);
});

app.post('/sync-shipments', async (c) => {
  const result = await syncShipments({});
  return c.json(result);
});

app.get('/sync-shipments', async (c) => {
  const result = await syncShipments({});
  return c.json(result);
});

// Run both orders + shipments in sequence. Shipments depend on orders being
// present to match by externalOrderId, so always run orders first.
app.post('/sync-all', async (c) => {
  const ordersResult = await syncOrders({});
  const shipmentsResult = await syncShipments({});
  return c.json({ orders: ordersResult, shipments: shipmentsResult });
});

export default app;
