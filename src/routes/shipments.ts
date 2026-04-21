import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';
import {
  getShipmentSyncStatus,
  syncShipments,
} from '../services/shipment-sync';

const app = new Hono();

// User-initiated sync + status. These sit behind requireAuth (mounted at
// main.ts). /cron/sync-shipments is the cron-secret equivalent for schedulers.
app.get('/status', async (c) => {
  const status = await getShipmentSyncStatus();
  return c.json(status);
});

app.post('/sync', async (c) => {
  const result = await syncShipments({});
  return c.json(result);
});

const listQuery = paginationSchema.extend({
  clientId: z.coerce.number().int().optional(),
  orderId: z.coerce.number().int().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  voided: z.coerce.boolean().optional(),
});

app.get('/', zValidator('query', listQuery), async (c) => {
  const q = c.req.valid('query');
  const where = and(
    ...[
      q.clientId !== undefined ? eq(shipments.clientId, q.clientId) : undefined,
      q.orderId !== undefined ? eq(shipments.orderId, q.orderId) : undefined,
      q.dateFrom ? gte(shipments.shipDate, new Date(q.dateFrom)) : undefined,
      q.dateTo ? lte(shipments.shipDate, new Date(q.dateTo)) : undefined,
      q.voided !== undefined ? eq(shipments.voided, q.voided) : undefined,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(shipments)
      .where(where)
      .orderBy(desc(shipments.shipDate))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    db.select({ count: sql<number>`count(*)::int` }).from(shipments).where(where),
  ]);

  return c.json(paginated(rows, countRows[0]?.count ?? 0, q));
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(shipments).where(eq(shipments.id, id)).limit(1);
  if (!row) return c.json({ error: 'Shipment not found' }, 404);
  return c.json(row);
});

export default app;
