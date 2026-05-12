import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import { clients } from '../db/schema/clients';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';
import {
  getShipmentSyncStatus,
  syncShipments,
} from '../services/shipment-sync';

const app = new Hono();

// 2026-05-13 visibility hardening (per `unlock shipped data` override
// from operator on 2026-05-13): the GET /shipments listing previously
// returned shipments owned by disabled clients. Per the boss directive
// that disabled clients data must not appear anywhere, this predicate
// filters shipments whose owning client has been deactivated. The
// shipments table itself is in the CLAUDE.md lockdown — this is a
// READ-side filter only, NOT an UPDATE/DELETE/schema change, so the
// underlying shipped data is untouched. Shipments with NULL clientId
// stay visible (legacy / pre-client-attribution rows), matching the
// same lenient policy as activeOrderClientPredicate in orders.ts.
const activeShipmentClientPredicate = sql`(
  ${shipments.clientId} is null
  or exists (
    select 1 from ${clients} owner_client
    where owner_client.id = ${shipments.clientId}
      and coalesce(owner_client.active, true) = true
  )
)`;

// User-initiated sync + status. These sit behind requireAuth (mounted at
// main.ts). /cron/sync-shipments is the cron-secret equivalent for schedulers.
app.get('/status', async (c) => {
  const status = await getShipmentSyncStatus();
  return c.json(status);
});

app.post('/sync', async (c) => {
  let sinceMs: number | undefined;
  try {
    const body = await c.req.json().catch(() => null);
    if (body && typeof body === 'object') {
      if (typeof body.sinceMs === 'number') sinceMs = body.sinceMs;
      if (body.fullResync === true) sinceMs = 0;
    }
  } catch {
    // empty body — use defaults
  }
  const result = await syncShipments({ sinceMs });
  return c.json(result);
});

const listQuery = paginationSchema.extend({
  clientId: z.coerce.number().int().optional(),
  orderId: z.coerce.number().int().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  voided: z.coerce.boolean().optional(),
  // Admin escape hatch — return shipments from disabled clients too.
  // Default behavior (omitted/false) excludes them, matching the
  // visibility policy used by every other listing route.
  includeInactiveClients: z.coerce.boolean().optional(),
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
      q.includeInactiveClients ? undefined : activeShipmentClientPredicate,
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
