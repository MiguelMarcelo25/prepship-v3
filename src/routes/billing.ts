import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { desc } from 'drizzle-orm';
import { db } from '../db/client';
import { billingConfig } from '../db/schema/billing';
import {
  billingDetails,
  billingSummary,
  generateLineItems,
  upsertBillingConfig,
} from '../services/billing';

const app = new Hono();

app.get('/config', async (c) => {
  const rows = await db
    .select()
    .from(billingConfig)
    .orderBy(desc(billingConfig.updatedAt));
  return c.json({ data: rows });
});

const configBody = z.object({
  pickPackFee: z.coerce.number().nonnegative().optional(),
  additionalUnitFee: z.coerce.number().nonnegative().optional(),
  packageCostMarkup: z.coerce.number().nonnegative().optional(),
  shippingMarkupPct: z.coerce.number().nonnegative().optional(),
  shippingMarkupFlat: z.coerce.number().nonnegative().optional(),
  billingMode: z.enum(['per_shipment', 'monthly']).optional(),
  active: z.boolean().optional(),
});

app.put(
  '/config/:clientId{[0-9]+}',
  zValidator('json', configBody),
  async (c) => {
    const clientId = Number(c.req.param('clientId'));
    const body = c.req.valid('json');
    const row = await upsertBillingConfig(clientId, {
      pickPackFee:
        body.pickPackFee !== undefined ? body.pickPackFee.toFixed(2) : undefined,
      additionalUnitFee:
        body.additionalUnitFee !== undefined
          ? body.additionalUnitFee.toFixed(2)
          : undefined,
      packageCostMarkup:
        body.packageCostMarkup !== undefined
          ? body.packageCostMarkup.toFixed(2)
          : undefined,
      shippingMarkupPct:
        body.shippingMarkupPct !== undefined
          ? body.shippingMarkupPct.toFixed(2)
          : undefined,
      shippingMarkupFlat:
        body.shippingMarkupFlat !== undefined
          ? body.shippingMarkupFlat.toFixed(2)
          : undefined,
      billingMode: body.billingMode,
      active: body.active,
    });
    return c.json(row);
  }
);

const generateSchema = z.object({
  clientId: z.coerce.number().int().optional(),
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
});

app.post('/generate', zValidator('json', generateSchema), async (c) => {
  const body = c.req.valid('json');
  const result = await generateLineItems(body);
  return c.json(result);
});

app.get('/summary', zValidator('query', generateSchema), async (c) => {
  const q = c.req.valid('query');
  const summary = await billingSummary(q);
  return c.json(summary);
});

app.get(
  '/details',
  zValidator('query', generateSchema.extend({ limit: z.coerce.number().int().max(2000).optional() })),
  async (c) => {
    const q = c.req.valid('query');
    const rows = await billingDetails(q);
    return c.json({ data: rows });
  }
);

export default app;
