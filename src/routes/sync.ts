import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getSyncStatus, syncOrders } from '../services/order-sync';

const app = new Hono();

const triggerBody = z
  .object({
    sinceIso: z.string().datetime().optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
    fullResync: z.boolean().optional(),
  })
  .optional()
  .default({});

app.post('/orders', zValidator('json', triggerBody), async (c) => {
  const body = c.req.valid('json') ?? {};
  const sinceMs = body.fullResync
    ? 0
    : body.sinceIso
      ? Date.parse(body.sinceIso)
      : undefined;
  const result = await syncOrders({
    sinceMs,
    pageSize: body.pageSize,
  });
  return c.json(result);
});

app.get('/status', async (c) => {
  const status = await getSyncStatus();
  return c.json(status);
});

export default app;
