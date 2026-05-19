import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { locations } from '../db/schema/locations';
import { packages } from '../db/schema/packages';
import { ssRequest } from '../lib/shipstation';
import type { CarriersResponse } from '../lib/shipstation/types';
import { publicClient } from '../lib/public-client';
import { filterClientsForScope, getClientStoreScope } from '../lib/client-store-scope';
import { EXCLUDED_STORE_IDS, EXCLUDED_STORE_IDS_SQL } from '../config/prepship';

const app = new Hono();

const COUNTS_CACHE_TTL_MS = 60_000;
type CountsPayload = {
  awaiting: number;
  shipped: number;
  cancelled: number;
  on_hold: number;
  queue: number;
  inventory: number;
  byStatus: Array<{ orderStatus: string; cnt: number }>;
  byStatusStore: Array<{ orderStatus: string; storeId: number; cnt: number }>;
};
const countsCache = new Map<string, { expiresAt: number; payload: CountsPayload }>();
const countsInflight = new Map<string, Promise<CountsPayload>>();

function countsCacheKey(dateFromIso: string | null, dateToIso: string | null): string {
  return `${dateFromIso ?? ''}|${dateToIso ?? ''}`;
}

function scopeFromContext(c: Context) {
  return getClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
}

// Single bootstrap call — returns everything needed to render the app shell.
app.get('/init-data', async (c) => {
  const [clientsRows, locationsRows, packagesRows] = await Promise.all([
    db.select().from(clients).where(eq(clients.active, true)),
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

  const scope = scopeFromContext(c);
  const visibleClients = filterClientsForScope(
    clientsRows.map(publicClient),
    scope
  );

  return c.json({
    clients: visibleClients,
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
  const cacheKey = countsCacheKey(dateFromIso, dateToIso);
  const cached = countsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return c.json(cached.payload);
  }
  const inflight = countsInflight.get(cacheKey);
  if (inflight) {
    return c.json(await inflight);
  }

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
  const visibleAwaitingOrdersPredicate = sql`not (
    (
      coalesce(o.external_order_id, '') ilike 'walmart-%'
      or coalesce(o.external_order_id, '') ilike 'ebay-%'
    )
    and o.order_number is not null
    and exists (
      select 1
      from orders real_marketplace_order
      where real_marketplace_order.order_number = o.order_number
        and real_marketplace_order.id <> o.id
        and coalesce(real_marketplace_order.external_order_id, '') not ilike 'walmart-%'
        and coalesce(real_marketplace_order.external_order_id, '') not ilike 'ebay-%'
        and real_marketplace_order.store_id is not null
        and real_marketplace_order.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
    )
  )`;

  const loadCounts = (async (): Promise<CountsPayload> => {
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
            and ${visibleAwaitingOrdersPredicate}
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
        (
          select count(*)::int
          from inventory i
          where i.active = true
            and (
              i.client_id is null
              or exists (
                select 1 from clients inventory_client
                where inventory_client.id = i.client_id
                  and coalesce(inventory_client.active, true) = true
              )
            )
        ) as inventory
    `),
    db.execute<{ orderStatus: string; cnt: number }>(sql`
      select o.order_status as "orderStatus", count(*)::int as cnt
      from orders o
      left join clients c on c.id = o.client_id
        where ${visibleOrderPredicate}
        ${orderDateFilter()}
        and (
          o.order_status is distinct from 'awaiting_shipment'
          or ${visibleAwaitingOrdersPredicate}
        )
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
        and (
          o.order_status is distinct from 'awaiting_shipment'
          or ${visibleAwaitingOrdersPredicate}
        )
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
    return { ...totals, byStatus, byStatusStore };
  })();

  countsInflight.set(cacheKey, loadCounts);
  try {
    const payload = await loadCounts;
    countsCache.set(cacheKey, {
      expiresAt: Date.now() + COUNTS_CACHE_TTL_MS,
      payload,
    });
    return c.json(payload);
  } finally {
    countsInflight.delete(cacheKey);
  }
});

// Direct alias for /rates/carriers — old API exposed it under /init too.
app.get('/carrier-accounts', async (c) => {
  try {
    const res = await ssRequest<CarriersResponse>('/v2/carriers', {
      dedupeKey: 'carriers:list',
    });
    return c.json(res);
  } catch (err) {
    console.warn(
      '[init/carrier-accounts] failed:',
      err instanceof Error ? err.message : String(err)
    );
    return c.json({ error: 'Failed to load carrier accounts', carriers: [] }, 502);
  }
});

// v2 parity: GET /stores — list all ShipStation stores derived from clients.
// v2 returns one row per (clientId, storeId) pairing. We hydrate from clients.storeIds.
app.get('/stores', async (c) => {
  const rows = await db.select().from(clients);
  const scope = scopeFromContext(c);
  const visibleClients = filterClientsForScope(rows.map(publicClient), scope);
  const stores: Array<{
    storeId: number;
    clientId: number;
    clientName: string;
    active: boolean;
  }> = [];
  for (const cli of visibleClients) {
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

// 2026-05-12: list the ShipStation accounts known to this deploy so the
// Settings → Carriers tab can render a row for each one alongside the
// per-client direct carriers (UPS, EasyPost, Walmart Shipping). The
// SECRETS are not returned — only a presence flag + a friendly label
// so the FE can show "ShipStation · DR PREPPER" etc. without ever
// touching the actual API key.
//
// Sources (matches src/lib/imported-handlers/rates-multi.ts:8-10):
//   1. env.SHIPSTATION_API_KEY_V2          → 'DR PREPPER'
//   2. env.SHIPSTATION_KFG_API_KEY_V2      → 'KFG'
//   3. clients.ssApiKeyV2 (per-client)     → client.name
//
// Per-client rows are already rendered FE-side by the Carriers card
// (it derives `hasOwnAccount` from useClients()), so this endpoint
// only emits the two env-level accounts. Field shape mirrors the
// per-client row shape close enough that the FE can dedupe / merge.
app.get('/shipstation-accounts', async (c) => {
  const accounts: Array<{
    id: string;
    name: string;
    keySource: string;
    available: boolean;
    apiVersion: 'v2' | 'v1';
  }> = [];

  if (process.env.SHIPSTATION_API_KEY_V2) {
    accounts.push({
      id: 'env:DR_PREPPER',
      name: 'DR PREPPER',
      keySource: 'env.SHIPSTATION_API_KEY_V2',
      available: true,
      apiVersion: 'v2',
    });
  }
  if (process.env.SHIPSTATION_KFG_API_KEY_V2) {
    accounts.push({
      id: 'env:KFG',
      name: 'KFG',
      keySource: 'env.SHIPSTATION_KFG_API_KEY_V2',
      available: true,
      apiVersion: 'v2',
    });
  }
  // Legacy v1 default — only emit when the v2 key is absent, otherwise
  // we'd double-count the DR PREPPER account under two API versions.
  if (!process.env.SHIPSTATION_API_KEY_V2 && process.env.SHIPSTATION_API_KEY) {
    accounts.push({
      id: 'env:DR_PREPPER_V1',
      name: 'DR PREPPER',
      keySource: 'env.SHIPSTATION_API_KEY',
      available: true,
      apiVersion: 'v1',
    });
  }

  return c.json({ data: accounts });
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
    console.warn(
      '[init/carriers] failed:',
      err instanceof Error ? err.message : String(err)
    );
    return c.json({ error: 'Failed to load carriers', data: [] }, 502);
  }
});

export default app;
