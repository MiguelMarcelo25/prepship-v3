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
  // v2-parity: sidebar top-level totals exclude hidden clients (Api
  // Shipments), is_test clients (Test Orders), and stale awaitings
  // (>30 days — matches v2's effective sync horizon). Shipped +
  // cancelled keep their full history so the all-time badges stay big.
  const rows = await db.execute<{
    awaiting: number;
    shipped: number;
    cancelled: number;
    on_hold: number;
    queue: number;
    inventory: number;
  }>(sql`
    select
      (
        select count(*)::int from orders o
        where o.order_status = 'awaiting_shipment'
          and (o.order_date is null or o.order_date >= now() - interval '14 days')
          and not exists (
            select 1 from clients c
            where c.id = o.client_id
              and (c.is_test = true or lower(c.name) = 'api shipments')
          )
      ) as awaiting,
      (
        select count(*)::int from orders o
        where o.order_status = 'shipped'
          and not exists (
            select 1 from clients c
            where c.id = o.client_id
              and (c.is_test = true or lower(c.name) = 'api shipments')
          )
      ) as shipped,
      (
        select count(*)::int from orders o
        where o.order_status = 'cancelled'
          and not exists (
            select 1 from clients c
            where c.id = o.client_id
              and (c.is_test = true or lower(c.name) = 'api shipments')
          )
      ) as cancelled,
      (
        select count(*)::int from orders o
        where o.order_status = 'on_hold'
          and not exists (
            select 1 from clients c
            where c.id = o.client_id
              and (c.is_test = true or lower(c.name) = 'api shipments')
          )
      ) as on_hold,
      (select count(*)::int from print_queue_orders where status = 'queued') as queue,
      (select count(*)::int from inventory where active = true) as inventory
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

// v2 parity: GET /stores — list all ShipStation stores derived from clients.
// v2 returns one row per (clientId, storeId) pairing. We hydrate from clients.storeIds.
app.get('/stores', async (c) => {
  const rows = await db.select().from(clients);
  const stores: Array<{
    storeId: number;
    clientId: number;
    clientName: string;
    active: boolean;
  }> = [];
  for (const cli of rows) {
    if (!cli.active) continue;
    const ids = Array.isArray(cli.storeIds) ? (cli.storeIds as number[]) : [];
    for (const sid of ids) {
      stores.push({ storeId: sid, clientId: cli.id, clientName: cli.name, active: true });
    }
  }
  return c.json({ data: stores });
});

// v2 parity: GET /carriers — slimmer projection of /carrier-accounts keyed by carrier_code.
app.get('/carriers', async (c) => {
  try {
    const res = await ssRequest<CarriersResponse>('/v2/carriers', {
      dedupeKey: 'carriers:list',
    });
    return c.json({
      data: res.carriers.map((c) => ({
        carrierId: c.carrier_id,
        carrierCode: c.carrier_code,
        nickname: c.nickname ?? c.friendly_name ?? c.carrier_code,
        services: (c.services ?? []).map((s) => ({
          serviceCode: s.service_code,
          name: s.name,
          domestic: s.domestic ?? true,
          international: s.international ?? false,
        })),
      })),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message, data: [] }, 502);
  }
});

export default app;
