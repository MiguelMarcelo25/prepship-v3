import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { locations } from '../db/schema/locations';
import { packages } from '../db/schema/packages';
import { ssRequest } from '../lib/shipstation';
import type { CarriersResponse } from '../lib/shipstation/types';

const app = new Hono();

// Single bootstrap call — returns everything needed to render the app shell.
app.get('/init-data', async (c) => {
  const [clientsRows, locationsRows, packagesRows] = await Promise.all([
    db.select().from(clients),
    db.select().from(locations),
    db.select().from(packages),
  ]);

  let carriers: CarriersResponse['carriers'] = [];
  try {
    const res = await ssRequest<CarriersResponse>('/v2/carriers', {
      dedupeKey: 'carriers:list',
    });
    carriers = res.carriers;
  } catch {
    // ShipStation may be down or creds missing — return what we have.
  }

  return c.json({
    clients: clientsRows,
    locations: locationsRows,
    packages: packagesRows,
    carriers,
  });
});

// Quick counts for nav badges / status chips.
app.get('/counts', async (c) => {
  const rows = await db.execute<{
    awaiting: number;
    shipped: number;
    cancelled: number;
    on_hold: number;
    queue: number;
    inventory: number;
  }>(sql`
    select
      (select count(*)::int from orders where order_status = 'awaiting_shipment') as awaiting,
      (select count(*)::int from orders where order_status = 'shipped')           as shipped,
      (select count(*)::int from orders where order_status = 'cancelled')         as cancelled,
      (select count(*)::int from orders where order_status = 'on_hold')           as on_hold,
      (select count(*)::int from print_queue_orders where status = 'queued')      as queue,
      (select count(*)::int from inventory where active = true)                   as inventory
  `);
  return c.json(
    rows[0] ?? {
      awaiting: 0,
      shipped: 0,
      cancelled: 0,
      on_hold: 0,
      queue: 0,
      inventory: 0,
    }
  );
});

// Direct alias for /rates/carriers — old API exposed it under /init too.
app.get('/carrier-accounts', async (c) => {
  try {
    const res = await ssRequest<CarriersResponse>('/v2/carriers', {
      dedupeKey: 'carriers:list',
    });
    return c.json(res);
  } catch (err) {
    return c.json({ error: (err as Error).message, carriers: [] }, 502);
  }
});

export default app;
