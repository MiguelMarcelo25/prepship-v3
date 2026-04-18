import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';

const app = new Hono();

const query = z.object({
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
  carrierCode: z.string().optional(),
  clientId: z.coerce.number().int().optional(),
});

app.get('/generate', zValidator('query', query), async (c) => {
  const q = c.req.valid('query');
  const rows = await db
    .select({
      id: shipments.id,
      orderId: shipments.orderId,
      orderNumber: shipments.orderNumber,
      clientId: shipments.clientId,
      carrierCode: shipments.carrierCode,
      serviceCode: shipments.serviceCode,
      trackingNumber: shipments.trackingNumber,
      shipDate: shipments.shipDate,
      weightOz: shipments.weightOz,
      labelCost: shipments.labelCost,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.voided, false),
        gte(shipments.shipDate, new Date(q.dateFrom)),
        lte(shipments.shipDate, new Date(q.dateTo)),
        q.carrierCode ? eq(shipments.carrierCode, q.carrierCode) : undefined,
        q.clientId !== undefined ? eq(shipments.clientId, q.clientId) : undefined
      )
    )
    .orderBy(asc(shipments.shipDate), asc(shipments.id));

  return c.json({
    data: rows,
    generatedAt: new Date().toISOString(),
    count: rows.length,
  });
});

export default app;
