import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { activeClientPredicateSql } from '../lib/active-client-predicate';
import { clients } from '../db/schema/clients';
import { orders } from '../db/schema/orders';
import { listShipStationStores } from '../connectors/store/shipstation';
import { publicClient } from '../lib/public-client';
import {
  filterClientsForScope,
  getClientStoreScope,
  isClientVisibleToScope,
} from '../lib/client-store-scope';
// PS-240 (Per user override unlock shipped data on 2026-06-13): client CRUD is an
// internal-admin action — block portal roles + scope-check each target client.
import {
  requireBusinessRoutePolicy,
  requireInternalPermission,
} from '../middleware/auth';
import { intArraySql } from '../lib/scope-sql';
import { EXCLUDED_STORE_IDS_SQL, isExcludedStoreId } from '../config/prepship';
import { orderLifecycleEffectiveStatusAliasSql } from '../services/order-lifecycle-status';
import { manualOrdersOrderPredicateSql } from '../lib/manual-orders-visibility';
import { validateClientRateSourceWrite } from '../services/client-rate-source-policy';

const app = new Hono();

function boolQuery(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parsePositiveIntQuery(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function lightweightClient(row: ReturnType<typeof publicClient>) {
  return {
    id: row.id,
    name: row.name,
    storeIds: row.storeIds,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone,
    active: row.active,
    isTest: row.isTest,
    rateSourceClientId: row.rateSourceClientId,
    brandName: row.brandName,
    brandColor: row.brandColor,
    brandLogo: row.brandLogo,
    hasShipStationV1Credentials: row.hasShipStationV1Credentials,
    hasShipStationV2Credentials: row.hasShipStationV2Credentials,
  };
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

function clientAggregateOrderScopePredicate(
  scope: ReturnType<typeof scopeFromContext>,
): SQL {
  if (!scope.isRestricted) return sql`true`;
  const predicates: SQL[] = [];
  if (scope.clientIds.length) {
    predicates.push(sql`o.client_id = any(${intArraySql(scope.clientIds)})`);
  }
  if (scope.storeIds.length) {
    predicates.push(sql`o.store_id = any(${intArraySql(scope.storeIds)})`);
  }
  if (!predicates.length) return sql`false`;
  return predicates.length === 1
    ? predicates[0]!
    : sql`(${sql.join(predicates, sql` or `)})`;
}

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
  const includeInactive = boolQuery(c.req.query('includeInactive'));
  const activeOnlyRaw = c.req.query('activeOnly');
  const activeOnly = activeOnlyRaw === undefined ? !includeInactive : boolQuery(activeOnlyRaw);
  const rows = await db
    .select()
    .from(clients)
    .where(activeOnly ? eq(clients.active, true) : undefined);
  const scope = scopeFromContext(c);
  const safeRows = rows.map(publicClient);
  const visibleRows = filterClientsForScope(safeRows, scope);
  const wantsPaged =
    c.req.query('page') !== undefined ||
    c.req.query('pageSize') !== undefined ||
    c.req.query('lightweight') !== undefined;
  if (wantsPaged) {
    const page = parsePositiveIntQuery(c.req.query('page'), 1, 100000);
    const pageSize = parsePositiveIntQuery(c.req.query('pageSize'), 100, 500);
    const start = (page - 1) * pageSize;
    const lightweight = boolQuery(c.req.query('lightweight'));
    return c.json({
      data: visibleRows
        .slice(start, start + pageSize)
        .map((row) => (lightweight ? lightweightClient(row) : row)),
      pagination: {
        page,
        pageSize,
        total: visibleRows.length,
        totalPages: Math.max(1, Math.ceil(visibleRows.length / pageSize)),
      },
    });
  }
  return c.json(visibleRows);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  if (!row) return c.json({ error: 'Client not found' }, 404);
  const scope = scopeFromContext(c);
  const safeRow = publicClient(row);
  if (!isClientVisibleToScope(safeRow, scope)) {
    return c.json({ error: 'Client not found' }, 404);
  }
  return c.json(safeRow);
});

app.post('/', requireBusinessRoutePolicy('clients.catalog.create'), zValidator('json', body), async (c) => {
  const v = c.req.valid('json');
  const rateSourcePolicy = await validateClientRateSourceWrite({
    clientId: null,
    rateSourceClientId: v.rateSourceClientId ?? null,
  });
  if (!rateSourcePolicy.ok) {
    return c.json({ error: rateSourcePolicy.error, code: rateSourcePolicy.code }, 400);
  }
  const [row] = await db.insert(clients).values(v).returning();
  if (!row) return c.json({ error: 'Client create failed' }, 500);
  return c.json(publicClient(row), 201);
});

app.patch('/:id{[0-9]+}', requireBusinessRoutePolicy('clients.catalog.patch'), zValidator('json', body.partial()), async (c) => {
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  // PS-240: a scoped caller may only edit a client visible to its scope.
  const [existing] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  if (!existing) return c.json({ error: 'Client not found' }, 404);
  if (!isClientVisibleToScope(publicClient(existing), scopeFromContext(c))) {
    return c.json({ error: 'Client not found' }, 404);
  }
  if (v.rateSourceClientId !== undefined) {
    const rateSourcePolicy = await validateClientRateSourceWrite({
      clientId: id,
      rateSourceClientId: v.rateSourceClientId,
    });
    if (!rateSourcePolicy.ok) {
      return c.json({ error: rateSourcePolicy.error, code: rateSourcePolicy.code }, 400);
    }
  }
  const [row] = await db
    .update(clients)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(clients.id, id))
    .returning();
  if (!row) return c.json({ error: 'Client not found' }, 404);
  return c.json(publicClient(row));
});

app.delete('/:id{[0-9]+}', requireBusinessRoutePolicy('clients.catalog.delete'), async (c) => {
  const id = Number(c.req.param('id'));
  // PS-240: a scoped caller may only delete a client visible to its scope.
  const [existing] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  if (!existing) return c.json({ error: 'Client not found' }, 404);
  if (!isClientVisibleToScope(publicClient(existing), scopeFromContext(c))) {
    return c.json({ error: 'Client not found' }, 404);
  }
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
  requireBusinessRoutePolicy('clients.orders.backfill'),
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
    // PS-240: a scoped caller may only backfill into a client visible to its scope.
    if (!isClientVisibleToScope(publicClient(client), scopeFromContext(c))) {
      return c.json({ error: 'Client not found' }, 404);
    }
    // 2026-05-13 visibility hardening: refuse to backfill orders into
    // a disabled client. Without this guard, an operator could
    // accidentally reassign hundreds of orders to a store they have
    // explicitly turned off, then wonder why those orders later
    // disappeared from every list (every read endpoint filters
    // disabled clients out). The operator must re-enable the client
    // first via the Settings → Clients toggle, then run the backfill.
    if (client.active === false) {
      return c.json(
        {
          error: 'Cannot backfill orders into a disabled client',
          clientId: id,
          clientName: client.name,
          hint: 'Re-enable the client from Settings → Clients first, then retry the backfill.',
        },
        409,
      );
    }
    const storeIds = (client.storeIds ?? []).filter((storeId) => !isExcludedStoreId(storeId));
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
// PS-252: gate the store-sync mutation behind settings:write like the other client
// mutations (it upserts client rows from ShipStation) — the one clients route the
// original sweep missed. (/admin/* routes are already gated by requireAdmin at the
// main.ts mount; this was the only genuinely ungated clients mutation.)
app.post('/sync-stores', requireBusinessRoutePolicy('clients.catalog.sync-stores'), async (c) => {
  const stores = await listShipStationStores({
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
    if (isExcludedStoreId(s.storeId)) continue;
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
// raw.externallyFulfilled) OR already have a non-voided shipment. Without
// date params it counts all awaiting regardless of age; dateFrom/dateTo scope
// this endpoint to the same window as the orders list.
app.get(
  '/order-stats',
  zValidator(
    'query',
    z.object({
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
      includeInactive: z
        .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
        .optional()
        .transform((v) => v === true || v === 'true' || v === '1'),
    })
  ),
  async (c) => {
    const q = c.req.valid('query');
    const aggregateScopePredicate = clientAggregateOrderScopePredicate(scopeFromContext(c));
    const activeClientFilter = q.includeInactive
      ? sql``
      : sql`and exists (
          select 1 from clients visible_client
          where visible_client.id = o.client_id
            and ${sql.raw(activeClientPredicateSql('visible_client'))}
        )`;
    const dateFilter = sql`
      ${q.dateFrom ? sql`and o.order_date >= ${q.dateFrom}::timestamptz` : sql``}
      ${q.dateTo ? sql`and o.order_date <= ${q.dateTo}::timestamptz` : sql``}
    `;
    // Per user override unlock shipped data on 2026-07-06: PS-387 makes this
    // read-only client count surface group by the backend lifecycle SOT.
    const effectiveStatusSql = orderLifecycleEffectiveStatusAliasSql('o');
    const manualOrdersAwaitingPredicate = sql`(
      ${effectiveStatusSql} = 'awaiting_shipment'
      and ${sql.raw(manualOrdersOrderPredicateSql('o', 'manual_orders_client'))}
    )`;
    const rows = await db.execute<{
      client_id: number;
      order_status: string;
      count: number;
    }>(sql`
      select o.client_id, ${effectiveStatusSql} as order_status, count(*)::int as count
      from orders o
      where o.client_id is not null
        and ${aggregateScopePredicate}
        and (
          o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
          or ${manualOrdersAwaitingPredicate}
        )
        ${activeClientFilter}
        ${dateFilter}
        and not (
          ${effectiveStatusSql} = 'awaiting_shipment'
          and (
            coalesce(o.externally_shipped, false) = true
            or coalesce((o.raw->>'externallyFulfilled')::boolean, false) = true
            or exists (
              select 1 from shipments s
              where s.order_id = o.id and s.voided = false
            )
          )
        )
      group by o.client_id, ${effectiveStatusSql}
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
  }
);

// Orphan report: orders with a storeId not owned by any active client.
//
// 2026-05-12 visibility fix: the LEFT JOIN now only matches ACTIVE
// clients. Stores owned exclusively by clients the operator disabled
// in Settings → Clients now show up here as "orphans needing
// attention," which is the right operator signal — those orders are
// piling up against a disabled tenant and the operator needs to
// decide whether to reassign them or reactivate the client. Before
// this change, disabling a client silently hid their orphan orders
// instead of flagging them.
app.get(
  '/unassigned-orphans',
  requireInternalPermission('settings:read'),
  async (c) => {
  const rows = await db.execute<{ store_id: number; count: number }>(sql`
    select o.store_id, count(*)::int as count
    from orders o
    left join clients c
      on o.store_id = any(c.store_ids)
      and ${sql.raw(activeClientPredicateSql('c'))}
    where o.client_id is null
      and o.store_id is not null
      and c.id is null
      and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
    group by o.store_id
    order by count desc
  `);
  return c.json({ data: rows });
  },
);

export default app;
