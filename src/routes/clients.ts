import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { orders } from '../db/schema/orders';
import { ssV1Request } from '../lib/shipstation/v1-client';

const app = new Hono();

const body = z.object({
  name: z.string().min(1),
  storeIds: z.array(z.number().int()).optional(),
  contactName: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  ssApiKey: z.string().nullable().optional(),
  ssApiSecret: z.string().nullable().optional(),
  ssApiKeyV2: z.string().nullable().optional(),
  rateSourceClientId: z.number().int().nullable().optional(),
  brandName: z.string().nullable().optional(),
  brandColor: z.string().nullable().optional(),
  brandLogo: z.string().nullable().optional(),
  active: z.boolean().optional(),
  isTest: z.boolean().optional(),
});

app.get('/', async (c) => {
  const rows = await db.select().from(clients);
  return c.json(rows);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  if (!row) return c.json({ error: 'Client not found' }, 404);
  return c.json(row);
});

app.post('/', zValidator('json', body), async (c) => {
  const v = c.req.valid('json');
  const [row] = await db.insert(clients).values(v).returning();
  return c.json(row, 201);
});

app.patch('/:id{[0-9]+}', zValidator('json', body.partial()), async (c) => {
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(clients)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(clients.id, id))
    .returning();
  if (!row) return c.json({ error: 'Client not found' }, 404);
  return c.json(row);
});

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(clients).where(eq(clients.id, id)).returning();
  if (!row) return c.json({ error: 'Client not found' }, 404);
  return c.json({ deleted: true });
});

// Backfill: assign this client to every order whose storeId is in the
// client's storeIds array and currently has no client (or a different one,
// when ?overwrite=true).
const backfillQuery = z.object({
  overwrite: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

app.post(
  '/:id{[0-9]+}/backfill-orders',
  zValidator('query', backfillQuery),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { overwrite } = c.req.valid('query');
    const [client] = await db
      .select()
      .from(clients)
      .where(eq(clients.id, id))
      .limit(1);
    if (!client) return c.json({ error: 'Client not found' }, 404);
    const storeIds = client.storeIds ?? [];
    if (!storeIds.length) {
      return c.json({ updated: 0, message: 'Client has no storeIds configured' });
    }

    const where = overwrite
      ? inArray(orders.storeId, storeIds)
      : and(inArray(orders.storeId, storeIds), isNull(orders.clientId));

    const result = await db
      .update(orders)
      .set({ clientId: id, updatedAt: new Date() })
      .where(where)
      .returning({ id: orders.id });

    return c.json({
      updated: result.length,
      message: `Assigned ${result.length} orders to ${client.name}`,
    });
  }
);

// Pull stores from ShipStation v1 and upsert into clients (one client per
// store). Existing clients matched by storeIds containing the store_id are
// updated with name/email/phone; otherwise a new client is created with
// storeIds: [storeId].
app.post('/sync-stores', async (c) => {
  type SSStore = {
    storeId: number;
    storeName: string;
    marketplaceName?: string;
    accountName?: string | null;
    email?: string | null;
    phone?: string | null;
    companyName?: string | null;
    active?: boolean;
  };

  const stores = await ssV1Request<SSStore[]>('/stores', {
    dedupeKey: 'stores:list',
  });

  let inserted = 0;
  let updated = 0;

  const all = await db.select().from(clients);
  const byStoreId = new Map<number, (typeof all)[number]>();
  for (const c of all) {
    for (const sid of c.storeIds ?? []) byStoreId.set(sid, c);
  }

  for (const s of stores) {
    const existing = byStoreId.get(s.storeId);
    const fields = {
      name: s.storeName || s.companyName || `Store ${s.storeId}`,
      contactName: s.accountName ?? null,
      email: s.email ?? null,
      phone: s.phone ?? null,
      active: s.active ?? true,
    };
    if (existing) {
      await db
        .update(clients)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(clients.id, existing.id));
      updated += 1;
    } else {
      await db.insert(clients).values({ ...fields, storeIds: [s.storeId] });
      inserted += 1;
    }
  }

  return c.json({
    inserted,
    updated,
    message: `Synced ${inserted + updated} stores (${inserted} new, ${updated} updated)`,
  });
});

// Per-client order counts grouped by status (one row per client).
// v2-parity (sqlite-init-repository.ts:87-102): awaiting count excludes
// orders that are externally fulfilled (externally_shipped flag OR
// raw.externallyFulfilled) OR already have a non-voided shipment. NO
// date cutoff — v2 counts ALL awaiting regardless of age.
app.get('/order-stats', async (c) => {
  const rows = await db.execute<{
    client_id: number;
    order_status: string;
    count: number;
  }>(sql`
    select o.client_id, o.order_status, count(*)::int as count
    from orders o
    where o.client_id is not null
      and not (
        o.order_status = 'awaiting_shipment'
        and (
          coalesce(o.externally_shipped, false) = true
          or coalesce((o.raw->>'externallyFulfilled')::boolean, false) = true
          or exists (
            select 1 from shipments s
            where s.order_id = o.id and s.voided = false
          )
        )
      )
    group by o.client_id, o.order_status
  `);

  const byClient = new Map<
    number,
    {
      clientId: number;
      total: number;
      awaiting: number;
      shipped: number;
      cancelled: number;
      onHold: number;
      other: number;
    }
  >();
  for (const r of rows) {
    const cur = byClient.get(r.client_id) ?? {
      clientId: r.client_id,
      total: 0,
      awaiting: 0,
      shipped: 0,
      cancelled: 0,
      onHold: 0,
      other: 0,
    };
    cur.total += r.count;
    if (r.order_status === 'awaiting_shipment') cur.awaiting += r.count;
    else if (r.order_status === 'shipped') cur.shipped += r.count;
    else if (r.order_status === 'cancelled') cur.cancelled += r.count;
    else if (r.order_status === 'on_hold') cur.onHold += r.count;
    else cur.other += r.count;
    byClient.set(r.client_id, cur);
  }
  return c.json({ data: [...byClient.values()] });
});

// Orphan report: orders with a storeId not owned by any client
app.get('/unassigned-orphans', async (c) => {
  const rows = await db.execute<{ store_id: number; count: number }>(sql`
    select o.store_id, count(*)::int as count
    from orders o
    left join clients c on o.store_id = any(c.store_ids)
    where o.client_id is null
      and o.store_id is not null
      and c.id is null
    group by o.store_id
    order by count desc
  `);
  return c.json({ data: rows });
});

export default app;
