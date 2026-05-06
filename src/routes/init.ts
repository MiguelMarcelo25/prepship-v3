import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { locations } from '../db/schema/locations';
import { packages } from '../db/schema/packages';
import { ssRequest } from '../lib/shipstation';
import type { CarriersResponse } from '../lib/shipstation/types';
import { EXCLUDED_STORE_IDS, EXCLUDED_STORE_IDS_SQL } from '../config/prepship';

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
// v2-parity (apps/api/src/modules/init/data/sqlite-init-repository.ts:70-85):
// The awaiting count EXCLUDES orders that have been externally fulfilled via
// one of three mechanisms (matches v2's NOT clauses exactly):
//   1. `orders.externally_shipped = true` (set by users via /orders/:id/
//      shipped-external — v2's equivalent is `order_local.external_shipped`)
//   2. `raw.externallyFulfilled = true` (ShipStation marked it fulfilled
//      elsewhere — e.g., Amazon MCF, Shopify fulfillment service)
//   3. A non-voided shipment already exists for the order (PrepShip or
//      ShipStation created a label — the order is effectively shipped even
//      if ShipStation's status hasn't caught up yet)
// Also excludes the same hardcoded store IDs as v2, plus the hidden
// 'api shipments' client bucket. Test clients remain visible like v2.
// NO date cutoff — v2 counts ALL awaiting regardless of age. Stale orders
// that never transitioned are a real operational signal, not noise.
app.get('/counts', async (c) => {
  const dateFromRaw = c.req.query('dateFrom');
  const dateToRaw = c.req.query('dateTo');
  const dateFrom = dateFromRaw ? new Date(dateFromRaw) : null;
  const dateTo = dateToRaw ? new Date(dateToRaw) : null;
  const dateFromIso = dateFrom && !Number.isNaN(dateFrom.getTime()) ? dateFrom.toISOString() : null;
  const dateToIso = dateTo && !Number.isNaN(dateTo.getTime()) ? dateTo.toISOString() : null;
  const orderDateFilter = () => sql`
    ${dateFromIso ? sql`and o.order_date >= ${dateFromIso}::timestamptz` : sql``}
    ${dateToIso ? sql`and o.order_date <= ${dateToIso}::timestamptz` : sql``}
  `;

  // Test-client orders use store_id = NULL with a synthetic negative
  // (-client_id) elsewhere in the UI, so the totals/per-status queries used
  // to filter them out via `store_id is not null`. The byStatusStore query
  // below already INCLUDES them, which made the sidebar's parent badge
  // ("Awaiting Shipment 39") disagree with the sum of its children
  // ("Tran Agency 3 + KF Goods 4 + Walmart-DJC 1 + Test Orders 102 + …
  // = 141"). v2 never had this gap because both queries used the same
  // visibility predicate. Use one shared predicate here so parent and
  // children always agree.
  //
  // Active-client filter (added 2026-05-07): when a user disables a
  // client via Inventory > Clients (active=false), their orders should
  // disappear from the sidebar and main orders list. /init/stores
  // already filters by active, but /init/counts and /orders did not —
  // causing the sidebar to show "Store 9000001" (raw fallback) for
  // disabled clients because the counts included them but the
  // store-name resolver dropped them. Use coalesce(active, true) so
  // legacy clients with null `active` default to visible.
  const visibleOrderPredicate = sql`(
    (coalesce(c.is_test, false) = true and o.client_id is not null)
    or (
      o.store_id is not null
      and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
    )
  ) and coalesce(c.active, true) = true`;

  const [rows, byStatus, byStatusStore] = await Promise.all([
    db.execute<{
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
          left join clients c on c.id = o.client_id
          where o.order_status = 'awaiting_shipment'
            and ${visibleOrderPredicate}
            ${orderDateFilter()}
            and not exists (
              select 1 from clients hidden_client
              where hidden_client.id = o.client_id
                and lower(hidden_client.name) = 'api shipments'
            )
        ) as awaiting,
        (
          select count(*)::int from orders o
          left join clients c on c.id = o.client_id
          where o.order_status = 'shipped'
            and ${visibleOrderPredicate}
            ${orderDateFilter()}
            and not exists (
              select 1 from clients hidden_client
              where hidden_client.id = o.client_id
                and lower(hidden_client.name) = 'api shipments'
            )
        ) as shipped,
        (
          select count(*)::int from orders o
          left join clients c on c.id = o.client_id
          where o.order_status = 'cancelled'
            and ${visibleOrderPredicate}
            ${orderDateFilter()}
            and not exists (
              select 1 from clients hidden_client
              where hidden_client.id = o.client_id
                and lower(hidden_client.name) = 'api shipments'
            )
        ) as cancelled,
        (
          select count(*)::int from orders o
          left join clients c on c.id = o.client_id
          where o.order_status = 'on_hold'
            and ${visibleOrderPredicate}
            ${orderDateFilter()}
            and not exists (
              select 1 from clients hidden_client
              where hidden_client.id = o.client_id
                and lower(hidden_client.name) = 'api shipments'
            )
        ) as on_hold,
        (select count(*)::int from print_queue_orders where status = 'queued') as queue,
        (select count(*)::int from inventory where active = true) as inventory
    `),
    db.execute<{ orderStatus: string; cnt: number }>(sql`
      select o.order_status as "orderStatus", count(*)::int as cnt
      from orders o
      left join clients c on c.id = o.client_id
        where ${visibleOrderPredicate}
        ${orderDateFilter()}
        and not exists (
          select 1 from clients hidden_client
          where hidden_client.id = o.client_id
            and lower(hidden_client.name) = 'api shipments'
        )
      group by o.order_status
    `),
    db.execute<{ orderStatus: string; storeId: number; cnt: number }>(sql`
      select
        o.order_status as "orderStatus",
        case
          when coalesce(c.is_test, false) = true and o.client_id is not null then -o.client_id
          else o.store_id
        end::int as "storeId",
        count(*)::int as cnt
      from orders o
      left join clients c on c.id = o.client_id
        where ${visibleOrderPredicate}
        ${orderDateFilter()}
        and not exists (
          select 1 from clients hidden_client
          where hidden_client.id = o.client_id
            and lower(hidden_client.name) = 'api shipments'
        )
        group by
          o.order_status,
          case
            when coalesce(c.is_test, false) = true and o.client_id is not null then -o.client_id
            else o.store_id
          end
      order by cnt desc
    `),
  ]);
  const totals =
    rows[0] ?? {
      awaiting: 0,
      shipped: 0,
      cancelled: 0,
      on_hold: 0,
      queue: 0,
      inventory: 0,
    };
  return c.json({ ...totals, byStatus, byStatusStore });
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
    if (cli.isTest) {
      stores.push({ storeId: -cli.id, clientId: cli.id, clientName: cli.name, active: true });
      continue;
    }
    const ids = Array.isArray(cli.storeIds) ? (cli.storeIds as number[]) : [];
    for (const sid of ids) {
      if (EXCLUDED_STORE_IDS.includes(sid as (typeof EXCLUDED_STORE_IDS)[number])) continue;
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
