import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';

const app = new Hono();

const query = z.object({
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
  carrierCode: z.string().optional(),
  clientId: z.coerce.number().int().optional(),
});

// v2 parity: POST accepts {startDate, endDate, carrierId?, clientId?} — the
// v2 body shape — while v4's GET keeps the native {dateFrom, dateTo,
// carrierCode, clientId}. We normalize both into the shared filter set below
// so either entry point returns the exact same manifest payload.
const postBody = z.object({
  startDate: z.string().min(1).optional(),
  endDate: z.string().min(1).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  carrierId: z.string().optional(),
  carrierCode: z.string().optional(),
  clientId: z.coerce.number().int().optional(),
});

type ManifestFilters = {
  dateFrom: string;
  dateTo: string;
  carrierCode?: string;
  clientId?: number;
  scope?: ClientStoreScope;
};

function manifestScopeFromContext(c: Context): ClientStoreScope {
  return getClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
}

function manifestClientScopePredicate(scope: ClientStoreScope): SQL | undefined {
  if (!scope.isRestricted) return undefined;
  const predicates: SQL[] = [];
  if (scope.clientIds.length > 0) predicates.push(inArray(shipments.clientId, scope.clientIds));
  if (scope.storeIds.length > 0) {
    predicates.push(sql`exists (
      select 1
      from orders scoped_order
      where scoped_order.id = ${shipments.orderId}
        and scoped_order.store_id in (${sql.join(scope.storeIds.map((id) => sql`${id}`), sql`, `)})
    )`);
  }
  if (!predicates.length) return sql`false`;
  return predicates.length === 1 ? predicates[0] : sql`(${sql.join(predicates, sql` or `)})`;
}

async function loadManifest(filters: ManifestFilters) {
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
        gte(shipments.shipDate, new Date(filters.dateFrom)),
        lte(shipments.shipDate, new Date(filters.dateTo)),
        filters.carrierCode ? eq(shipments.carrierCode, filters.carrierCode) : undefined,
        filters.clientId !== undefined ? eq(shipments.clientId, filters.clientId) : undefined,
        filters.scope ? manifestClientScopePredicate(filters.scope) : undefined,
        // 2026-05-12 visibility fix: drop shipments owned by test
        // clients (sandbox data) OR by clients the operator disabled
        // via Settings → Clients. Previously only the test branch was
        // filtered, which let inactive clients' shipments slip into
        // the manifest PDF — annoying for the warehouse since they'd
        // see clients they thought were retired still showing up at
        // print time. Only applies when the caller does NOT explicitly
        // ask for a single client (explicit clientId trusts the
        // caller — admin/diagnostic flow).
        filters.clientId === undefined
          ? sql`not exists (select 1 from clients c where c.id = ${shipments.clientId} and (c.is_test = true or coalesce(c.active, true) = false))`
          : undefined
      )
    )
    .orderBy(asc(shipments.shipDate), asc(shipments.id));

  return {
    data: rows,
    generatedAt: new Date().toISOString(),
    count: rows.length,
  };
}

app.get('/generate', zValidator('query', query), async (c) => {
  const q = c.req.valid('query');
  const result = await loadManifest({
    dateFrom: q.dateFrom,
    dateTo: q.dateTo,
    carrierCode: q.carrierCode,
    clientId: q.clientId,
    scope: manifestScopeFromContext(c),
  });
  return c.json(result);
});

app.post('/generate', zValidator('json', postBody), async (c) => {
  const b = c.req.valid('json');
  const dateFrom = b.dateFrom ?? b.startDate;
  const dateTo = b.dateTo ?? b.endDate;
  if (!dateFrom || !dateTo) {
    return c.json({ error: 'startDate and endDate required' }, 400);
  }
  const result = await loadManifest({
    dateFrom,
    dateTo,
    // v2 used `carrierId`; the v4 schema keys off `carrierCode`. Accept
    // either — no translation table exists, so callers passing the legacy
    // carrier id string can still filter against shipments.carrierCode
    // (ShipStation uses the same lowercase code in both places).
    carrierCode: b.carrierCode ?? b.carrierId,
    clientId: b.clientId,
    scope: manifestScopeFromContext(c),
  });
  return c.json(result);
});

export default app;
