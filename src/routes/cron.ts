import { Hono } from 'hono';
import { env } from '../lib/env';
import { syncOrders } from '../services/order-sync';

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

export default app;
