import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { activeClientPredicateSql } from '../lib/active-client-predicate';
import { shipments } from '../db/schema/shipments';
import { clients } from '../db/schema/clients';
import { orders } from '../db/schema/orders';
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';
import { isResourceInScope } from '../lib/scope-predicates';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';
import {
  getShipmentSyncStatus,
} from '../services/shipment-sync';
import { enqueueManualShipmentSyncJob } from '../services/sync-job-queue';

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
      and ${sql.raw(activeClientPredicateSql('owner_client'))}
  )
)`;

// PS-233 (Per user override unlock shipped data on 2026-06-13): restrict the
// shipment listing to the caller's client/store scope. Previously the list only
// filtered DISABLED clients (activeShipmentClientPredicate) — NOT the caller's
// scope — so a restricted principal could read every tenant's shipments (and the
// recipient PII + label URLs they carry). shipments.clientId is the primary axis;
// store-scoped principals match via the owning order's store. Read-only filter.
function shipmentScopeFromContext(c: Context): ClientStoreScope {
  return getClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
}

function shipmentScopePredicate(scope: ClientStoreScope): SQL | undefined {
  if (!scope.isRestricted) return undefined;
  const predicates: SQL[] = [];
  if (scope.clientIds.length > 0) predicates.push(inArray(shipments.clientId, scope.clientIds));
  if (scope.storeIds.length > 0) {
    predicates.push(sql`exists (
      select 1 from orders scoped_order
      where scoped_order.id = ${shipments.orderId}
        and scoped_order.store_id in (${sql.join(scope.storeIds.map((id) => sql`${id}`), sql`, `)})
    )`);
  }
  if (!predicates.length) return sql`false`;
  return predicates.length === 1 ? predicates[0] : sql`(${sql.join(predicates, sql` or `)})`;
}

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
  const result = await enqueueManualShipmentSyncJob({
    sinceMs,
    fullResync: sinceMs === 0,
  });
  return c.json(
    {
      ...result,
      status: result.queued ? 'queued' : result.error ? 'error' : 'already_queued',
    },
    result.error ? 503 : 202,
  );
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
      // Per user override unlock shipped data on 2026-08-19: the generic shipment DTO is an
      // original-order surface. Replacement vessels are exposed only through the replacement
      // workflow, whose authorization and lifecycle semantics are intentionally separate.
      sql`${shipments.source} is distinct from 'replacement'`,
      q.clientId !== undefined ? eq(shipments.clientId, q.clientId) : undefined,
      q.orderId !== undefined ? eq(shipments.orderId, q.orderId) : undefined,
      q.dateFrom ? gte(shipments.shipDate, new Date(q.dateFrom)) : undefined,
      q.dateTo ? lte(shipments.shipDate, new Date(q.dateTo)) : undefined,
      q.voided !== undefined ? eq(shipments.voided, q.voided) : undefined,
      q.includeInactiveClients ? undefined : activeShipmentClientPredicate,
      // PS-233: never return shipments outside the caller's scope.
      shipmentScopePredicate(shipmentScopeFromContext(c)),
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
  const [row] = await db.select().from(shipments).where(and(
    eq(shipments.id, id),
    sql`${shipments.source} is distinct from 'replacement'`,
  )).limit(1);
  if (!row) return c.json({ error: 'Shipment not found' }, 404);
  // PS-233: out-of-scope shipment → same 404 as not-found (no cross-tenant leak).
  const scope = shipmentScopeFromContext(c);
  if (scope.isRestricted) {
    let inScope = isResourceInScope(scope, { clientId: row.clientId, storeId: null });
    if (!inScope && row.orderId != null) {
      const [owner] = await db
        .select({ clientId: orders.clientId, storeId: orders.storeId })
        .from(orders)
        .where(eq(orders.id, row.orderId))
        .limit(1);
      inScope = !!owner && isResourceInScope(scope, { clientId: owner.clientId, storeId: owner.storeId });
    }
    if (!inScope) return c.json({ error: 'Shipment not found' }, 404);
  }
  return c.json(row);
});

export default app;
