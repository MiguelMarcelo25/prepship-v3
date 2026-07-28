import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { normalizeScopeIds, intArraySql } from '../lib/scope-sql';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, getTableColumns, gte, ilike, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, sql as pg } from '../db/client';
import { env } from '../lib/env';
import { activeClientPredicateSql } from '../lib/active-client-predicate';
import {
  computeInventoryQuantityForIds,
  inventoryQuantitySql,
  type InventoryQuantityEntry,
} from '../services/inventory-stock-math';
import { cuFtPerUnit } from '../lib/inventory-cuft';
import { movementDirectionError } from '../lib/inventory-movement-direction';
import { resolveReceiveUnits } from '../lib/inventory-receive-units';
import { computeReorderPolicy } from '../lib/inventory-reorder-policy';
import { classifyStockStatus } from '../lib/inventory-stock-status';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { products } from '../db/schema/products';
import { inventorySkuParents } from '../db/schema/inventory-sku-parents';
import { orderItems } from '../db/schema/order-items';
import { orders } from '../db/schema/orders';
import { parentSkus } from '../db/schema/parent-skus';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';
import {
  type InventoryRouteTimings,
  msSince,
  timedInventoryStep,
  logSlowInventoryRoute,
} from '../lib/route-timing';
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';
import {
  hasAppPermission,
  hasInternalAppPermission,
  requireBusinessRoutePolicy,
  requireInternalPermission,
} from '../middleware/auth';
import { walmartDirectDuplicateSuppressionPredicate } from '../lib/walmart-order-dedupe';
import { applyMovement, inventoryStats } from '../services/inventory';
import {
  applyInventoryMovementInTransaction,
  type InventoryMovementTransaction,
} from '../services/inventory-movement';
import { ensureInventoryLedgerSchema } from '../services/inventory-ledger-schema';
import {
  importSkusFromOrders,
  syncShipStationProducts,
} from '../services/inventory-enrichment';
import { getFreshInventoryRiskMetricMap } from '../services/reporting-metrics';
import {
  buildReportingWindow,
  reportingOrderShipmentProjectionJoinSql,
} from '../services/reporting-projection';
import { getInventoryDeductionReport } from '../services/fulfillment/inventory-deduction-report';

const app = new Hono();

const booleanQuery = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return value;
}, z.boolean());

const activeInventoryClientPredicate = sql`(
  ${inventory.clientId} is null
  or exists (
    select 1 from clients visible_client
    where visible_client.id = ${inventory.clientId}
      and ${sql.raw(activeClientPredicateSql('visible_client'))}
  )
)`;

function inventoryScopeFromContext(c: Context): ClientStoreScope {
  return getClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
}

function canViewInventoryFinancials(c: Context): boolean {
  return hasAppPermission(
    {
      email: c.get('email' as never) as string | undefined,
      role: c.get('role' as never) as string | undefined,
      permissions: c.get('permissions' as never) as string[] | undefined,
    },
    'financials:read'
  );
}

function inventoryScopePredicate(scope: ClientStoreScope): SQL {
  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(scope.clientIds);
  const storeIds = normalizeScopeIds(scope.storeIds);

  if (clientIds.length) {
    predicates.push(sql`${inventory.clientId} = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`exists (
      select 1 from clients scoped_client
      where scoped_client.id = ${inventory.clientId}
        and scoped_client.store_ids && ${intArraySql(storeIds)}
    )`);
  }
  if (!predicates.length) {
    return scope.isRestricted ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

// PS-462: immutable movement identity is the history owner. Legacy rows created before
// phase 1 may have null identity columns, so only those rows fall back to the catalog row.
const ledgerClientIdSql = sql`coalesce(${inventoryLedger.clientId}, ${inventory.clientId})`;
const ledgerSkuSql = sql`coalesce(${inventoryLedger.sku}, ${inventory.sku})`;

function inventoryLedgerScopePredicate(scope: ClientStoreScope): SQL {
  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(scope.clientIds);
  const storeIds = normalizeScopeIds(scope.storeIds);
  if (clientIds.length) predicates.push(sql`${ledgerClientIdSql} = any(${intArraySql(clientIds)})`);
  if (storeIds.length) {
    predicates.push(sql`exists (
      select 1 from clients ledger_scoped_client
      where ledger_scoped_client.id = ${ledgerClientIdSql}
        and ledger_scoped_client.store_ids && ${intArraySql(storeIds)}
    )`);
  }
  if (!predicates.length) return scope.isRestricted ? sql`false` : sql`true`;
  return predicates.length === 1 ? predicates[0]! : sql`(${sql.join(predicates, sql` or `)})`;
}

// PS-247 (Card 2): cross-tenant guards for the inventory MUTATION routes. The read/list routes
// already filter by inventoryScopePredicate, but the mutations resolved rows by BARE id / trusted a
// body clientId, so a restricted (client_user) caller could create, patch, receive, adjust, re-parent,
// or bulk-edit ANY tenant's inventory. These close that IDOR:
//   - inventoryClientInScope: a body clientId the caller writes to must be in its scope (else 403).
//   - inventoryIdInScope: the row at :id must be in the caller's scope, else the route 404s (no
//     existence leak). Unrestricted/global callers pass through unchanged.
function inventoryClientInScope(scope: ClientStoreScope, clientId: number | null | undefined): boolean {
  if (!scope.isRestricted) return true;
  const allowed = normalizeScopeIds(scope.clientIds);
  return clientId != null && allowed.includes(clientId);
}

async function inventoryIdInScope(scope: ClientStoreScope, id: number): Promise<boolean> {
  if (!scope.isRestricted) return true;
  const [row] = await db
    .select({ id: inventory.id })
    .from(inventory)
    .where(and(eq(inventory.id, id), inventoryScopePredicate(scope)))
    .limit(1);
  return Boolean(row);
}

function inventoryOrderScopePredicate(scope: ClientStoreScope): SQL {
  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(scope.clientIds);
  const storeIds = normalizeScopeIds(scope.storeIds);

  if (clientIds.length) {
    predicates.push(sql`o.client_id = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`o.store_id = any(${intArraySql(storeIds)})`);
  }
  if (!predicates.length) {
    return scope.isRestricted ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

const listQuery = paginationSchema.extend({
  clientId: z.coerce.number().int().optional(),
  search: z.string().optional(),
  lowStock: booleanQuery.optional(),
  active: booleanQuery.optional(),
  // Opt-in flag — when true, the response includes inventory rows
  // where active=false. Default behavior (omitted/false) keeps the
  // legacy "active-only" semantics so the rate browser, order
  // auto-fulfillment lookups, and Receive tab don't accidentally
  // start seeing deactivated SKUs. Currently only the Stock Levels
  // tab sets this when its "Active only" toolbar toggle is off.
  includeInactive: booleanQuery.optional(),
  // Emergency/debug-only escape hatch. Normal page loads must use
  // worker-generated metrics or cheap row-level fallbacks instead of
  // scanning order history live.
  liveMetrics: booleanQuery.optional(),
});

app.get('/', zValidator('query', listQuery), async (c) => {
  const routeStartedAt = performance.now();
  const timings: InventoryRouteTimings = {};
  const q = c.req.valid('query');
  const scope = inventoryScopeFromContext(c);
  const shouldRunLiveMetrics = q.liveMetrics === true;
  if (shouldRunLiveMetrics) await ensureInventoryLedgerSchema();
  const where = and(
    ...[
      q.clientId !== undefined ? eq(inventory.clientId, q.clientId) : undefined,
      q.search
        ? or(
            ilike(inventory.sku, `%${q.search}%`),
            ilike(inventory.name, `%${q.search}%`)
          )
        : undefined,
      q.lowStock ? lte(inventoryQuantitySql(inventory.id), inventory.reorderLevel) : undefined,
      // Active filter: applied unless the caller explicitly asks
      // for everything via ?includeInactive=true.
      q.active !== undefined
        ? eq(inventory.active, q.active)
        : q.includeInactive ? undefined : eq(inventory.active, true),
      activeInventoryClientPredicate,
      inventoryScopePredicate(scope),
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );

  const [rows, countRows] = await timedInventoryStep(timings, 'pageAndCount', () =>
    Promise.all([
      db
        .select({
          ...getTableColumns(inventory),
          inventoryQuantity: inventoryQuantitySql(inventory.id),
          // Catalog fact from products, which is global by SKU while inventory
          // rows are per client. A scalar subquery rather than a leftJoin:
          // products.sku is unique but only case-sensitively, so 'HU-10' and
          // 'hu-10' can both exist and a normalised join predicate would fan
          // this row out into two. LIMIT 1 keeps it one row per inventory row.
          hazmat: sql<boolean>`coalesce((
            select p.hazmat from ${products} p
            where upper(btrim(p.sku)) = upper(btrim(${inventory.sku}))
            limit 1
          ), false)`,
        })
        .from(inventory)
        .where(where)
        .orderBy(desc(inventory.updatedAt))
        .limit(q.pageSize)
        .offset(offsetOf(q)),
      db.select({ count: sql<number>`count(*)::int` }).from(inventory).where(where),
    ])
  );

  const metricByInventoryId = rows.length
    ? await timedInventoryStep(timings, 'reportingMetrics', () =>
        getFreshInventoryRiskMetricMap(rows.map((row) => row.id), { maxAgeMinutes: 45 })
          .catch((err) => {
            console.warn(
              '[inventory:list] reporting metrics unavailable:',
              err instanceof Error ? err.message : err
            );
            return new Map();
          })
      )
    : new Map();
  const hasFreshMetrics = rows.length > 0 && metricByInventoryId.size === rows.length;

  const soldRows = rows.length && shouldRunLiveMetrics
    ? await timedInventoryStep(timings, 'soldLast30Days', () =>
        db.execute<{ inventory_id: number; sold_last_30_days: number }>(sql`
        select
          l.inventory_id,
          abs(coalesce(sum(l.qty), 0))::int as sold_last_30_days
        from ${inventoryLedger} l
        where l.inventory_id in (${sql.join(rows.map((row) => sql`${row.id}`), sql`, `)})
          and l.type = 'ship'
          and coalesce(l.effective_at, l.created_at) >= now() - interval '30 days'
        group by l.inventory_id
      `)
      )
    : [];
  const soldByInventoryId = new Map(
    soldRows.map((row) => [row.inventory_id, Number(row.sold_last_30_days) || 0])
  );

  // 2026-05-13 / refined 2026-05-14 (a+b+c): operator reported the
  // STOCK column shows numbers that don't match -SOLD. Root cause:
  // The former cached balance was only mutated by the auto-deduct path, which
  // didn't track historical orders shipped before the system came
  // online and skips edge cases like external labels.
  //
  // Definition (current — revision (c) 2026-05-14):
  //
  //   inventory quantity = signed sum of persisted ledger movements
  //
  // The one non-obvious filter on the sold counter:
  //   Only count `order_status = 'shipped'` (NOT "any non-
  //   cancelled order"). An awaiting_shipment order represents a
  //   future commitment, not inventory that has physically left
  //   the building. STOCK is meant to reflect what we actually
  //   have on the floor right now.
  //
  // History of attempts:
  //   (a) sum of all non-cancelled order quantities — inflated by
  //       awaiting_shipment orders, didn't match operator's "what
  //       has actually gone out" mental model.
  //   (b) anchored sold counter at inventory.created_at — backfired
  //       on auto-synced SKUs whose created_at is TODAY but whose
  //       order history goes back further. Most SKUs are auto-
  //       synced, so most rows came out wrong.
  //   (c) (current) no created_at anchor. For an operator who hasn't
  //       received anything, STOCK = −(every order they've ever
  //       shipped for this SKU). Matches their mental model
  //       exactly: "we haven't received any, so STOCK should be
  //       what's gone."
  //
  // Returns: if a shipment carries `isReturn=true` we should
  // technically add the qty back. We don't yet — returns are rare
  // and the shipments table doesn't break down qty per item.
  //
  // SOLD 30D stays unrelated to this — it's an unbounded "last 30
  // days regardless of status" window by design, used as a "recent
  // velocity" indicator, not a stock signal.
  //
  // PS-439 removes the cached balance and exposes the signed ledger sum as
  // `inventoryQuantity`; reviewed historical correction remains append-only.
  //
  // Allowed under the shipped-data lockdown: this is a READ-only
  // analytics computation. No locked rows are mutated.
  // The inventory list, dashboard, and discrepancy report delegate to the same owner.
  const quantityByInventoryId = rows.length
    ? await timedInventoryStep(timings, 'inventoryQuantity', () =>
        computeInventoryQuantityForIds(rows.map((row) => row.id)),
      )
    : new Map<number, InventoryQuantityEntry>();

  const response = paginated(
    rows.map((row) => {
      const metric = metricByInventoryId.get(row.id);
      if (metric) {
        const quantity = quantityByInventoryId.get(row.id);
        const inventoryQuantity = quantity?.inventoryQuantity ?? (Number(row.inventoryQuantity) || 0);
        const soldLast30Days = soldByInventoryId.get(row.id) ?? metric.soldLast30Days;
        const reorder = computeReorderPolicy({
          units30: soldLast30Days,
          stock: inventoryQuantity,
          minStock: Number(row.reorderLevel ?? 0),
        });
        return {
          ...row,
          soldLast7Days: metric.soldLast7Days,
          soldLast30Days,
          velocityPerDay: reorder.velocityPerDay,
          daysSupply: reorder.daysSupply,
          restockQty: reorder.restockQty,
          inventoryQuantity,
          stockStatus: classifyStockStatus(inventoryQuantity, Number(row.reorderLevel ?? 0)),
          totalReceived: quantity?.totalReceived ?? metric.totalReceived,
          totalSoldAllTime: quantity?.totalShipped ?? metric.totalSoldAllTime,
          // PS-324: per-unit cubic feet is a billing input (storage fee). The backend owns
          // the formula (cuFtPerUnit, mirroring src/services/billing.ts) so the displayed
          // cuFt can't drift from the billed cuFt; the FE renders this instead of computing it.
          cuFt: cuFtPerUnit(row.cuFtOverride, row.length, row.width, row.height),
        };
      }
      const inventoryQuantity = Number(row.inventoryQuantity ?? 0) || 0;
      const reorderLevel = Number(row.reorderLevel ?? 0) || 0;
      const soldLast30Days = soldByInventoryId.get(row.id) ?? 0;
      const reorder = computeReorderPolicy({
        units30: soldLast30Days,
        stock: inventoryQuantity,
        minStock: reorderLevel,
      });
      const quantity = quantityByInventoryId.get(row.id) ?? {
        totalReceived: 0,
        totalShipped: 0,
        inventoryQuantity,
      };
      return {
        ...row,
        soldLast7Days: 0,
        soldLast30Days,
        velocityPerDay: reorder.velocityPerDay,
        daysSupply: reorder.daysSupply,
        restockQty: reorder.restockQty,
        // NEW fields — see comment block above the SQL.
        inventoryQuantity: quantity.inventoryQuantity,
        stockStatus: classifyStockStatus(quantity.inventoryQuantity, reorderLevel),
        totalReceived: quantity.totalReceived,
        totalSoldAllTime: quantity.totalShipped,
        // PS-324: backend-owned per-unit cubic feet (billing storage input); see above branch.
        cuFt: cuFtPerUnit(row.cuFtOverride, row.length, row.width, row.height),
      };
    }),
    countRows[0]?.count ?? 0,
    q
  );

  logSlowInventoryRoute('list', timings, msSince(routeStartedAt), {
    page: q.page,
    pageSize: q.pageSize,
    total: countRows[0]?.count ?? 0,
    rows: rows.length,
    clientId: q.clientId ?? null,
    hasSearch: Boolean(q.search?.trim()),
    lowStock: q.lowStock ?? false,
    active: q.active ?? null,
    includeInactive: q.includeInactive ?? false,
  });

  return c.json(response);
});

// Global ledger query — flattens the ledger across all SKUs with filters.
// Safe: the id-scoped `/:id{[0-9]+}/ledger` below won't match the literal
// string "ledger" because the regex constrains :id to digits.
const ledgerQuery = paginationSchema.extend({
  clientId: z.coerce.number().int().optional(),
  sku: z.string().optional(),
  type: z.string().optional(),
  dateStart: z.coerce.number().optional(),
  dateEnd: z.coerce.number().optional(),
});

app.get('/ledger', zValidator('query', ledgerQuery), async (c) => {
  const routeStartedAt = performance.now();
  const timings: InventoryRouteTimings = {};
  const q = c.req.valid('query');
  const ledgerScope = inventoryScopeFromContext(c);
  const dateStart = q.dateStart != null && Number.isFinite(q.dateStart) ? new Date(q.dateStart) : null;
  const dateEnd = q.dateEnd != null && Number.isFinite(q.dateEnd) ? new Date(q.dateEnd) : null;
  const dateStartIso = dateStart && !Number.isNaN(dateStart.getTime()) ? dateStart.toISOString() : null;
  const dateEndIso = dateEnd && !Number.isNaN(dateEnd.getTime()) ? dateEnd.toISOString() : null;
  const skuFilter = q.sku?.trim() || null;
  const pageOffset = offsetOf(q);
  await ensureInventoryLedgerSchema();

  const pageRows = await timedInventoryStep(timings, 'pageAndCount', () => db.execute<{
    id: number;
    inventoryId: number;
    sku: string | null;
    name: string | null;
    clientId: number | null;
    type: string;
    qty: number;
    orderId: number | null;
    note: string | null;
    createdBy: string | null;
    effectiveAt: Date;
    createdAt: Date;
    totalCount: number;
  }>(sql`
    with ledger_rows as (
      select
        ${inventoryLedger.id}::int as id,
        ${inventoryLedger.inventoryId} as inventory_id,
        ${ledgerSkuSql} as sku,
        ${inventory.name} as name,
        ${ledgerClientIdSql} as client_id,
        ${inventoryLedger.type} as type,
        ${inventoryLedger.qty} as qty,
        ${inventoryLedger.orderId} as order_id,
        ${inventoryLedger.note} as note,
        ${inventoryLedger.createdBy} as created_by,
        coalesce(${inventoryLedger.effectiveAt}, ${inventoryLedger.createdAt}) as effective_at,
        ${inventoryLedger.createdAt} as created_at
      from ${inventoryLedger}
      inner join ${inventory} on ${inventory.id} = ${inventoryLedger.inventoryId}
      where (${q.clientId ?? null}::int is null or ${ledgerClientIdSql} = ${q.clientId ?? null}::int)
        and (${skuFilter}::text is null or lower(${ledgerSkuSql}) = lower(${skuFilter}::text))
        and (${q.type ?? null}::text is null or ${inventoryLedger.type} = ${q.type ?? null}::text)
        and (${dateStartIso}::timestamptz is null or coalesce(${inventoryLedger.effectiveAt}, ${inventoryLedger.createdAt}) >= ${dateStartIso}::timestamptz)
        and (${dateEndIso}::timestamptz is null or coalesce(${inventoryLedger.effectiveAt}, ${inventoryLedger.createdAt}) <= ${dateEndIso}::timestamptz)
        and (${ledgerClientIdSql} is null or exists (
          select 1 from clients visible_ledger_client
          where visible_ledger_client.id = ${ledgerClientIdSql}
            and ${sql.raw(activeClientPredicateSql('visible_ledger_client'))}
        ))
        and ${inventoryLedgerScopePredicate(ledgerScope)}
    )
    select
      id::int as id,
      inventory_id as "inventoryId",
      sku,
      name,
      client_id as "clientId",
      type,
      qty,
      order_id as "orderId",
      note,
      created_by as "createdBy",
      effective_at as "effectiveAt",
      created_at as "createdAt",
      count(*) over()::int as "totalCount"
    from ledger_rows
    order by effective_at desc, id desc
    limit ${q.pageSize}
    offset ${pageOffset}
  `));

  const rows = pageRows.map(({ totalCount: _totalCount, ...row }) => row);
  const totalCount = Number(pageRows[0]?.totalCount ?? 0);

  logSlowInventoryRoute('ledger', timings, msSince(routeStartedAt), {
    page: q.page,
    pageSize: q.pageSize,
    total: totalCount,
    rows: rows.length,
    clientId: q.clientId ?? null,
    type: q.type ?? null,
    hasSku: Boolean(q.sku?.trim()),
  });

  return c.json(paginated(rows, totalCount, q));
});

app.delete(
  '/ledger/:ledgerId{[0-9]+}',
  requireBusinessRoutePolicy('inventory.ledger.delete'),
  async (c) => {
  const ledgerId = Number(c.req.param('ledgerId'));
  const scope = inventoryScopeFromContext(c);
  const email = c.get('email' as never) as string | undefined;

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: inventoryLedger.id,
        inventoryId: inventoryLedger.inventoryId,
        type: inventoryLedger.type,
        qty: inventoryLedger.qty,
        orderId: inventoryLedger.orderId,
        sku: ledgerSkuSql,
      })
      .from(inventoryLedger)
      .innerJoin(inventory, eq(inventory.id, inventoryLedger.inventoryId))
      .where(and(eq(inventoryLedger.id, ledgerId), inventoryLedgerScopePredicate(scope)))
      .limit(1);

    if (!row) return { status: 404 as const };
    if (row.orderId != null || row.type === 'ship') {
      return { status: 409 as const, row };
    }

    const reversedAt = new Date();
    const reversal = await applyInventoryMovementInTransaction(tx, {
      inventoryId: row.inventoryId,
      type: 'adjust',
      qty: -row.qty,
      note: `Reversal of inventory ledger movement ${ledgerId}`,
      createdBy: email ?? 'manual',
      effectiveAt: reversedAt,
      idempotencyKey: `inventory:ledger-reversal:${ledgerId}`,
      sourceEntity: 'inventory_ledger',
      sourceId: `reversal:${ledgerId}`,
    });

    return { status: 200 as const, row, inventory: reversal.inventory, reversal: reversal.ledger };
  });

  if (result.status === 404) {
    return c.json({ error: 'Inventory history row not found' }, 404);
  }
  if (result.status === 409) {
    return c.json({
      error: 'Order-linked ship history cannot be reversed from Inventory History.',
      ledgerId,
      type: result.row.type,
      orderId: result.row.orderId,
    }, 409);
  }

  console.info('[inventory:ledger-reversal] immutable reversal appended', {
    ledgerId,
    inventoryId: result.row.inventoryId,
    sku: result.row.sku,
    type: result.row.type,
    qty: result.row.qty,
    reversedBy: email ?? 'unknown',
  });

  return c.json({
    ok: true,
    reversed: result.row,
    reversal: result.reversal,
    inventory: result.inventory,
  });
  },
);

app.get('/stats', async (c) => {
  const clientId = c.req.query('clientId');
  const parsed = clientId !== undefined ? Number(clientId) : undefined;
  const statsScope = inventoryScopeFromContext(c);
  const stats = await inventoryStats(
    Number.isFinite(parsed as number) ? (parsed as number) : undefined,
    inventoryScopePredicate(statsScope)
  );
  return c.json(stats);
});

const inventoryDeductionReportQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// PS-450: internal, read-only reconciliation view over parked/failed inventory
// deduction delivery. The route carries auth + validated input only; outbox
// classification remains in the backend report owner and no mutation is issued.
app.get(
  '/deduction-outbox-report',
  requireInternalPermission('settings:read'),
  zValidator('query', inventoryDeductionReportQuery),
  async (c) => c.json(await getInventoryDeductionReport(pg, {
    inventoryAutoDeductEnabled: env.INVENTORY_AUTO_DEDUCT,
    limit: c.req.valid('query').limit,
  })),
);

// v2-parity: GET /inventory/alerts?clientId=N
// Returns low-stock items from the same canonical ledger expression used by the list.
app.get(
  '/alerts',
  zValidator('query', z.object({ clientId: z.coerce.number().int().optional() })),
  async (c) => {
    const { clientId } = c.req.valid('query');
    const alertsScope = inventoryScopeFromContext(c);
    const rows = await db
      .select({
        id: inventory.id,
        sku: inventory.sku,
        name: inventory.name,
        inventoryQuantity: inventoryQuantitySql(inventory.id),
        minStock: inventory.reorderLevel,
        parentSkuId: inventory.parentSkuId,
        clientId: inventory.clientId,
      })
      .from(inventory)
      .where(
        and(
          ...[
            clientId !== undefined ? eq(inventory.clientId, clientId) : undefined,
            eq(inventory.active, true),
            activeInventoryClientPredicate,
            inventoryScopePredicate(alertsScope),
            lte(inventoryQuantitySql(inventory.id), inventory.reorderLevel),
          ].filter(<T>(x: T | undefined): x is T => x !== undefined)
        )
      )
      .orderBy(inventoryQuantitySql(inventory.id));
    return c.json({ data: rows.map((r) => ({ type: 'sku' as const, ...r })) });
  }
);

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const detailScope = inventoryScopeFromContext(c);
  const [row] = await db
    .select({
      ...getTableColumns(inventory),
      inventoryQuantity: inventoryQuantitySql(inventory.id),
    })
    .from(inventory)
    .where(and(eq(inventory.id, id), inventoryScopePredicate(detailScope)))
    .limit(1);
  if (!row) return c.json({ error: 'Inventory item not found' }, 404);
  return c.json(row);
});

app.get('/:id{[0-9]+}/ledger', async (c) => {
  const id = Number(c.req.param('id'));
  const ledgerDetailScope = inventoryScopeFromContext(c);
  await ensureInventoryLedgerSchema();
  const rows = await db
    .select({
      id: inventoryLedger.id,
      inventoryId: inventoryLedger.inventoryId,
      type: inventoryLedger.type,
      qty: inventoryLedger.qty,
      orderId: inventoryLedger.orderId,
      note: inventoryLedger.note,
      createdBy: inventoryLedger.createdBy,
      effectiveAt: inventoryLedger.effectiveAt,
      createdAt: inventoryLedger.createdAt,
    })
    .from(inventoryLedger)
    .innerJoin(inventory, eq(inventory.id, inventoryLedger.inventoryId))
    .where(and(eq(inventoryLedger.inventoryId, id), inventoryScopePredicate(ledgerDetailScope)))
    .orderBy(desc(sql`coalesce(${inventoryLedger.effectiveAt}, ${inventoryLedger.createdAt})`))
    .limit(200);
  return c.json({ data: rows });
});

// Orders that contain this SKU, bounded by an optional date window.
// Scans orders.items JSONB for any element with {sku: <this sku>} and
// returns an ordered list for the Inventory view's "Used by" panel.
app.get(
  '/:id{[0-9]+}/sku-orders',
  zValidator(
    'query',
    z.object({
      days: z.coerce.number().int().positive().max(3650).optional(),
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
    })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { days, dateFrom, dateTo } = c.req.valid('query');
    const skuOrdersScope = inventoryScopeFromContext(c);
    const canViewFinancials = canViewInventoryFinancials(c);

    const [row] = await db
      .select({ sku: inventory.sku, name: inventory.name, clientId: inventory.clientId })
      .from(inventory)
      .where(and(eq(inventory.id, id), inventoryScopePredicate(skuOrdersScope)))
      .limit(1);
    if (!row) return c.json({ error: 'Inventory item not found' }, 404);

    const since = dateFrom
      ? buildReportingWindow({ from: dateFrom, to: dateFrom }).dateFrom
      : days
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
        : null;
    const until = dateTo
      ? buildReportingWindow({ from: dateTo, to: dateTo }).dateToInclusive
      : null;
    const dateFilterSql = sql`
      ${since ? sql`and o.order_date >= ${since}::timestamptz` : sql``}
      ${until ? sql`and o.order_date <= ${until}::timestamptz` : sql``}
    `;

    // 2026-05-13 visibility hardening: this endpoint matches orders by
    // SKU STRING (not by client_id), so when two clients share a SKU
    // string and one is disabled, the disabled client's orders mix
    // into the SKU drawer's daily-sales chart and shipping-cost
    // averages. Filtering by `coalesce(c.active, true) = true` excludes
    // disabled clients' orders from the three CTEs below while keeping
    // cross-client SKU analytics intact for ACTIVE clients. Orders
    // with NULL client_id (test/orphan) still pass through, matching
    // the same lenient policy as activeOrderClientPredicate in orders.ts.
    const activeClientOrderFilter = sql`
      and (
        o.client_id is null
        or exists (
          select 1 from clients c
          where c.id = o.client_id
            and ${sql.raw(activeClientPredicateSql('c'))}
        )
      )
      and ${inventoryOrderScopePredicate(skuOrdersScope)}
      and o.client_id is not distinct from ${row.clientId}::int
    `;
    const walmartCanonicalOrderFilter = walmartDirectDuplicateSuppressionPredicate('o');

    const dailyRows = since || until
      ? await db.execute<{ day: string; units: number }>(sql`
          select
            to_char(date_trunc('day', o.order_date at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') as day,
            sum(oi.quantity)::int                                  as units
          from order_items oi
          join orders o on o.id = oi.order_id
          where lower(oi.sku) = lower(${row.sku})
            ${dateFilterSql}
            and coalesce(o.order_status, '') <> 'cancelled'
            and oi.quantity > 0
            ${activeClientOrderFilter}
            and ${walmartCanonicalOrderFilter}
          group by date_trunc('day', o.order_date at time zone 'America/Los_Angeles')
          order by date_trunc('day', o.order_date at time zone 'America/Los_Angeles') asc
        `)
      : [];
    const salesMap = new Map(dailyRows.map((r) => [r.day, Number(r.units ?? 0)]));
    const dailySales: { day: string; units: number }[] = [];
    const safeDays = Math.max(1, Math.min(3650, days ?? 30));
    // Day buckets are California calendar days so the contiguous axis lines up
    // with the CA-grouped SQL above (date_trunc(... at time zone
    // 'America/Los_Angeles')). Generating UTC days here would misalign the
    // boundary days by the UTC/PT offset and drop their sales counts.
    const laDayParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const laDayString = (d: Date): string => {
      const p = Object.fromEntries(laDayParts.formatToParts(d).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}`;
    };
    const startInstant = since ? new Date(since) : new Date(Date.now() - (safeDays - 1) * 24 * 60 * 60 * 1000);
    const endInstant = until ? new Date(until) : new Date();
    // Treat each CA day string as a pure calendar token: parse as UTC midnight,
    // step by whole UTC days, format back. The endpoints are CA days, so every
    // produced label is a CA day that matches the SQL keys.
    const cursor = new Date(`${laDayString(startInstant)}T00:00:00Z`);
    const endCursor = new Date(`${laDayString(endInstant)}T00:00:00Z`);
    let bucketGuard = 0;
    while (cursor.getTime() <= endCursor.getTime() && bucketGuard < 3651) {
      const day = cursor.toISOString().slice(0, 10);
      dailySales.push({ day, units: salesMap.get(day) ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      bucketGuard += 1;
    }

    const [shippingSummary] = await db.execute<{
      standard_ship_count: number;
      standard_shipping_total: string;
      avg_standard_shipping_cost: string;
    }>(sql`
      with matching_order_ids as (
        select distinct
          o.id
        from order_items oi
        join orders o on o.id = oi.order_id
        where lower(oi.sku) = lower(${row.sku})
          ${dateFilterSql}
          and coalesce(o.order_status, '') <> 'cancelled'
          and oi.quantity > 0
          ${activeClientOrderFilter}
          and ${walmartCanonicalOrderFilter}
      ),
      item_rows as (
        select
          o.id                                                               as order_id,
          o.order_status                                                     as order_status,
          coalesce(ls.service_code, o.service_code)                          as service_code,
          ls.order_id                                                        as shipment_order_id,
          coalesce(ls.selected_cost, 0)                                      as label_cost,
          coalesce(ls.standard_cost, 0)                                      as standard_label_cost,
          oi.sku                                                            as sku,
          oi.sku                                                            as sku_key,
          coalesce(nullif(oi.name, ''), '-')                                 as name,
          greatest(0, coalesce(oi.quantity, 0))::int                         as qty
        from matching_order_ids moi
        join orders o on o.id = moi.id
        join order_items oi on oi.order_id = o.id
        ${reportingOrderShipmentProjectionJoinSql(sql`o.id`, 'ls')}
        where oi.quantity > 0
      ),
      order_sku_rows as (
        select
          order_id,
          max(order_status)                                                   as order_status,
          max(service_code)                                                    as service_code,
          max(shipment_order_id)                                               as shipment_order_id,
          max(label_cost)                                                      as label_cost,
          max(standard_label_cost)                                             as standard_label_cost,
          sku_key,
          max(sku)                                                             as sku,
          sum(qty)::int                                                        as qty
        from item_rows
        group by order_id, sku_key
      ),
      allocated as (
        select
          r.*,
          sum(qty) over (partition by r.order_id)::int                         as order_qty_total,
          case
            when r.order_status = 'shipped' and r.shipment_order_id is null then true
            else false
          end                                                                 as is_external
        from order_sku_rows r
      )
      select
        count(*) filter (
          where lower(sku) = lower(${row.sku})
            and not is_external
            and standard_label_cost > 0
        )::int as standard_ship_count,
        coalesce(sum(standard_label_cost * qty / nullif(order_qty_total, 0)) filter (
          where lower(sku) = lower(${row.sku})
            and not is_external
            and standard_label_cost > 0
        ), 0)::text as standard_shipping_total,
        coalesce(
          sum(standard_label_cost * qty / nullif(order_qty_total, 0)) filter (
            where lower(sku) = lower(${row.sku})
              and not is_external
              and standard_label_cost > 0
          )
          / nullif(sum(qty) filter (
            where lower(sku) = lower(${row.sku})
              and not is_external
              and standard_label_cost > 0
          ), 0),
          0
        )::text as avg_standard_shipping_cost
      from allocated
    `);

    const rows = await db.execute<{
      order_id: number;
      order_number: string;
      order_date: string | null;
      order_status: string;
      ship_to_name: string | null;
      carrier_code: string | null;
      service_code: string | null;
      qty: number;
      unit_price: string | null;
      item_name: string | null;
      shipping_cost: string | null;
      shipping_total: string | null;
      standard_shipping_cost: string | null;
      standard_shipping_total: string | null;
      is_external_shipped: boolean;
    }>(sql`
      with matching_order_ids as (
        select distinct
          o.id
        from order_items oi
        join orders o on o.id = oi.order_id
        where lower(oi.sku) = lower(${row.sku})
          ${dateFilterSql}
          and coalesce(o.order_status, '') <> 'cancelled'
          and oi.quantity > 0
          ${activeClientOrderFilter}
          and ${walmartCanonicalOrderFilter}
      ),
      item_rows as (
        select
          o.id                                                               as order_id,
          o.order_number                                                     as order_number,
          o.order_date                                                       as order_date,
          o.order_status                                                     as order_status,
          o.ship_to_name                                                     as ship_to_name,
          o.carrier_code                                                     as carrier_code,
          coalesce(ls.service_code, o.service_code)                          as service_code,
          ls.order_id                                                        as shipment_order_id,
          coalesce(ls.selected_cost, 0)                                      as label_cost,
          coalesce(ls.standard_cost, 0)                                      as standard_label_cost,
          coalesce(o.externally_shipped, false)                              as externally_shipped_flag,
          oi.sku                                                            as sku,
          oi.sku                                                            as sku_key,
          coalesce(nullif(oi.name, ''), '-')                                 as item_name,
          greatest(0, coalesce(oi.quantity, 0))::int                         as qty,
          oi.unit_price::text                                                as unit_price
        from matching_order_ids moi
        join orders o on o.id = moi.id
        join order_items oi on oi.order_id = o.id
        ${reportingOrderShipmentProjectionJoinSql(sql`o.id`, 'ls')}
        where oi.quantity > 0
      ),
      order_sku_rows as (
        select
          order_id,
          max(order_number)                                                   as order_number,
          min(order_date)                                                      as order_date,
          max(order_status)                                                    as order_status,
          max(ship_to_name)                                                    as ship_to_name,
          max(carrier_code)                                                    as carrier_code,
          max(service_code)                                                    as service_code,
          max(shipment_order_id)                                               as shipment_order_id,
          max(label_cost)                                                      as label_cost,
          max(standard_label_cost)                                             as standard_label_cost,
          bool_or(externally_shipped_flag)                                     as externally_shipped_flag,
          sku_key,
          max(sku)                                                             as sku,
          (array_agg(item_name order by length(item_name) desc))[1]            as item_name,
          sum(qty)::int                                                        as qty,
          max(unit_price)                                                      as unit_price
        from item_rows
        group by order_id, sku_key
      ),
      allocated as (
        select
          r.*,
          sum(qty) over (partition by r.order_id)::int                         as order_qty_total,
          case
            when r.order_status = 'shipped' and r.shipment_order_id is null then true
            else false
          end                                                                 as is_external
        from order_sku_rows r
      )
      select
        order_id,
        order_number,
        order_date,
        order_status,
        ship_to_name,
        carrier_code,
        service_code,
        qty,
        unit_price,
        item_name,
        case
          when not is_external and label_cost > 0 then (label_cost / nullif(order_qty_total, 0))::text
          else null
        end as shipping_cost,
        case
          when not is_external and label_cost > 0 then (label_cost * qty / nullif(order_qty_total, 0))::text
          else null
        end as shipping_total,
        case
          when not is_external and standard_label_cost > 0 then (standard_label_cost / nullif(order_qty_total, 0))::text
          else null
        end as standard_shipping_cost,
        case
          when not is_external and standard_label_cost > 0 then (standard_label_cost * qty / nullif(order_qty_total, 0))::text
          else null
        end as standard_shipping_total,
        (is_external or externally_shipped_flag)                               as is_external_shipped
      from allocated
      where lower(sku) = lower(${row.sku})
      order by order_date desc nulls last
      limit 200
    `);

    const visibleShippingSummary = canViewFinancials ? shippingSummary : null;
    const visibleRows = canViewFinancials
      ? rows
      : rows.map((orderRow) => ({
          ...orderRow,
          shipping_cost: null,
          shipping_total: null,
          standard_shipping_cost: null,
          standard_shipping_total: null,
        }));

    return c.json({
      sku: row.sku,
      name: row.name,
      clientId: row.clientId,
      totalUnits: dailySales.reduce((sum, r) => sum + r.units, 0),
      standardShipCount: visibleShippingSummary?.standard_ship_count ?? 0,
      standardShippingTotal: visibleShippingSummary?.standard_shipping_total ?? '0',
      avgStandardShippingCost: visibleShippingSummary?.avg_standard_shipping_cost ?? '0',
      dailySales,
      orders: visibleRows,
    });
  }
);

const createBody = z.object({
  clientId: z.number().int().nullable().optional(),
  sku: z.string().min(1),
  name: z.string().optional(),
  imageUrl: z.string().url().nullable().optional(),
  inventoryQuantity: z.number().int().optional(),
  reorderLevel: z.number().int().nonnegative().optional(),
  baseUnitQty: z.number().int().positive().optional(),
  unitsPerPack: z.number().int().positive().optional(),
  cuFtOverride: z.number().nonnegative().nullable().optional(),
  packageId: z.number().int().positive().nullable().optional(),
  weightOz: z.number().nonnegative().nullable().optional(),
  length: z.number().nonnegative().nullable().optional(),
  width: z.number().nonnegative().nullable().optional(),
  height: z.number().nonnegative().nullable().optional(),
  // 2026-05-12: `active` was missing from this schema, so PATCHes
  // from the toolbar/per-row toggle had the field silently stripped
  // by zod's default .strip() mode — the row's updatedAt bumped but
  // the active column never changed. Adding it here makes the
  // active-only toggle and the per-row toggle actually persist.
  active: z.boolean().optional(),
});

app.post(
  '/',
  requireBusinessRoutePolicy('inventory.catalog.create'),
  zValidator('json', createBody),
  async (c) => {
  const body = c.req.valid('json');
  // PS-247: a restricted caller may only create inventory in its own client scope.
  if (!inventoryClientInScope(inventoryScopeFromContext(c), body.clientId)) {
    return c.json({ error: 'Inventory client out of scope' }, 403);
  }
  const { inventoryQuantity = 0, ...values } = body;
  const email = c.get('email' as never) as string | undefined;
  await ensureInventoryLedgerSchema();
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(inventory).values(values).returning();
    if (!created || inventoryQuantity === 0) {
      return created ? { ...created, inventoryQuantity: 0 } : created;
    }
    const movement = await applyInventoryMovementInTransaction(tx, {
      inventoryId: created.id,
      type: 'adjust',
      qty: inventoryQuantity,
      note: 'Opening stock',
      createdBy: email ?? 'manual',
      effectiveAt: new Date(),
      idempotencyKey: `inventory:opening:${created.id}`,
      sourceEntity: 'inventory',
      sourceId: `opening:${created.id}`,
    });
    if (movement.status !== 'applied') throw new Error('Opening stock movement was not applied');
    return movement.inventory;
  });
  return c.json(row, 201);
  },
);

app.patch(
  '/:id{[0-9]+}',
  requireBusinessRoutePolicy('inventory.catalog.patch'),
  zValidator(
    'json',
    createBody
      .omit({ sku: true, inventoryQuantity: true })
      .partial()
      .extend({ sku: z.string().min(1).optional() })
      .strict(),
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    const scope = inventoryScopeFromContext(c);
    // PS-247: out-of-scope rows fall outside the predicate -> no update -> 404 (no cross-tenant edit).
    if (inventoryClientInScope(scope, body.clientId) === false) {
      return c.json({ error: 'Inventory client out of scope' }, 403);
    }
    try {
      const result = await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: inventory.id, clientId: inventory.clientId, sku: inventory.sku })
          .from(inventory)
          .where(and(eq(inventory.id, id), inventoryScopePredicate(scope)))
          .limit(1);
        if (!current) return { status: 404 as const };

        const identityChanged =
          (body.clientId !== undefined && body.clientId !== current.clientId) ||
          (body.sku !== undefined && body.sku !== current.sku);
        if (identityChanged) {
          const [movement] = await tx
            .select({ id: inventoryLedger.id })
            .from(inventoryLedger)
            .where(eq(inventoryLedger.inventoryId, id))
            .limit(1);
          if (movement) return { status: 409 as const };
        }

        const [row] = await tx
          .update(inventory)
          .set({ ...body, updatedAt: new Date() })
          .where(and(eq(inventory.id, id), inventoryScopePredicate(scope)))
          .returning();
        return row ? { status: 200 as const, row } : { status: 404 as const };
      });
      if (result.status === 404) return c.json({ error: 'Inventory item not found' }, 404);
      if (result.status === 409) {
        return c.json({
          error: 'Inventory client and SKU are immutable after movement history exists. Create a new inventory row and use reviewed paired movements.',
        }, 409);
      }
      return c.json(result.row);
    } catch (error) {
      if (error instanceof Error && error.message.includes('PS462_INVENTORY_IDENTITY_IMMUTABLE')) {
        return c.json({
          error: 'Inventory client and SKU are immutable after movement history exists. Create a new inventory row and use reviewed paired movements.',
        }, 409);
      }
      throw error;
    }
  }
);

const movementBody = z.object({
  qty: z.number().int(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  note: z.string().optional(),
  orderId: z.number().int().optional(),
  type: z.enum(['receive', 'adjust', 'pick', 'ship', 'return', 'damage']).optional(),
  receivedAt: z.string().datetime().optional(),
  adjustedAt: z.string().datetime().optional(),
});

function movementDateFrom(value: string | undefined) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function movementRequestIdentity(c: Context, prefix: string, bodyKey?: string) {
  const supplied = bodyKey?.trim() || c.req.header('Idempotency-Key')?.trim();
  const requestId = supplied || randomUUID();
  return {
    idempotencyKey: `${prefix}:${requestId}`,
    sourceEntity: 'inventory_api',
    sourceId: `${prefix}:${requestId}`,
  };
}

app.post(
  '/:id{[0-9]+}/receive',
  requireBusinessRoutePolicy('inventory.receive.one'),
  zValidator('json', movementBody.refine((v) => v.qty > 0, 'Receive qty must be > 0')),
  async (c) => {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    // PS-247: a restricted caller may only receive into its own inventory.
    if (!(await inventoryIdInScope(inventoryScopeFromContext(c), id))) {
      return c.json({ error: 'Inventory item not found' }, 404);
    }
    const email = c.get('email' as never) as string | undefined;
    const identity = movementRequestIdentity(c, `receive:${id}`, body.idempotencyKey);
    const result = await applyMovement({
      inventoryId: id,
      type: 'receive',
      qty: body.qty,
      note: body.note,
      createdBy: email ?? 'manual',
      effectiveAt: movementDateFrom(body.receivedAt ?? body.adjustedAt) ?? new Date(),
      ...identity,
    });
    return c.json(result);
  }
);

app.put(
  '/:id{[0-9]+}/set-parent',
  requireBusinessRoutePolicy('inventory.catalog.set-parent'),
  zValidator(
    'json',
    z.object({ parentSkuId: z.number().int().positive().nullable() })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { parentSkuId } = c.req.valid('json');
    const scope = inventoryScopeFromContext(c);
    // Dual-write: update inventory.parentSkuId FK (primary parent — back-compat)
    // AND upsert inventory_sku_parents join (v2-parity multi-parent table).
    // When parentSkuId is null, clear both: null out the FK and delete the
    // primary row from the join.
    // PS-247: out-of-scope row falls outside the predicate -> no update -> 404 (no cross-tenant re-parent).
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(inventory)
        .set({ parentSkuId, updatedAt: new Date() })
        .where(and(eq(inventory.id, id), inventoryScopePredicate(scope)))
        .returning();
      if (!row) return null;

      // Clear any existing primary row for this inventory id so the unique
      // partial index doesn't fight us on a re-parent.
      await tx
        .delete(inventorySkuParents)
        .where(
          and(
            eq(inventorySkuParents.inventoryId, id),
            eq(inventorySkuParents.isPrimary, true)
          )
        );

      if (parentSkuId !== null) {
        await tx
          .insert(inventorySkuParents)
          .values({ inventoryId: id, parentSkuId, isPrimary: true })
          .onConflictDoUpdate({
            target: [inventorySkuParents.inventoryId, inventorySkuParents.parentSkuId],
            set: { isPrimary: true },
          });
      }
      return row;
    });
    if (!result) return c.json({ error: 'Inventory item not found' }, 404);
    return c.json(result);
  }
);

// v2-parity: list all parent SKUs a given inventory row belongs to (may be
// many, since an inventory item can belong to multiple bundles). Uses the
// join table + left-joins parent_skus for display fields.
app.get('/:id{[0-9]+}/parents', async (c) => {
  const id = Number(c.req.param('id'));
  const parentsScope = inventoryScopeFromContext(c);
  const rows = await db
    .select({
      parentSkuId: inventorySkuParents.parentSkuId,
      isPrimary: inventorySkuParents.isPrimary,
      createdAt: inventorySkuParents.createdAt,
      name: parentSkus.name,
      sku: parentSkus.sku,
      baseUnitQty: parentSkus.baseUnitQty,
    })
    .from(inventorySkuParents)
    .innerJoin(inventory, eq(inventory.id, inventorySkuParents.inventoryId))
    .innerJoin(parentSkus, eq(parentSkus.id, inventorySkuParents.parentSkuId))
    .where(and(eq(inventorySkuParents.inventoryId, id), inventoryScopePredicate(parentsScope)))
    .orderBy(desc(inventorySkuParents.isPrimary), parentSkus.name);
  return c.json({ data: rows });
});

// Add a non-primary parent (idempotent). For primary parent use /set-parent.
app.post(
  '/:id{[0-9]+}/add-parent',
  requireBusinessRoutePolicy('inventory.catalog.add-parent'),
  zValidator(
    'json',
    z.object({ parentSkuId: z.number().int().positive() })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { parentSkuId } = c.req.valid('json');
    // PS-247: the target inventory row must be in the caller's scope.
    const [inv] = await db
      .select({ id: inventory.id })
      .from(inventory)
      .where(and(eq(inventory.id, id), inventoryScopePredicate(inventoryScopeFromContext(c))))
      .limit(1);
    if (!inv) return c.json({ error: 'Inventory item not found' }, 404);

    await db
      .insert(inventorySkuParents)
      .values({ inventoryId: id, parentSkuId, isPrimary: false })
      .onConflictDoNothing({
        target: [inventorySkuParents.inventoryId, inventorySkuParents.parentSkuId],
      });
    return c.json({ data: { inventoryId: id, parentSkuId, isPrimary: false } });
  }
);

// Remove a parent from the join. If it was the primary parent, also null
// out inventory.parentSkuId so the two representations stay consistent.
app.delete(
  '/:id{[0-9]+}/parents/:parentSkuId{[0-9]+}',
  requireBusinessRoutePolicy('inventory.catalog.remove-parent'),
  async (c) => {
    const id = Number(c.req.param('id'));
    const parentSkuId = Number(c.req.param('parentSkuId'));
    // PS-247: a restricted caller may only edit parent links on its own inventory.
    if (!(await inventoryIdInScope(inventoryScopeFromContext(c), id))) {
      return c.json({ error: 'Parent link not found' }, 404);
    }
    const result = await db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(inventorySkuParents)
        .where(
          and(
            eq(inventorySkuParents.inventoryId, id),
            eq(inventorySkuParents.parentSkuId, parentSkuId)
          )
        )
        .returning();
      if (removed?.isPrimary) {
        await tx
          .update(inventory)
          .set({ parentSkuId: null, updatedAt: new Date() })
          .where(eq(inventory.id, id));
      }
      return removed;
    });
    if (!result) return c.json({ error: 'Parent link not found' }, 404);
    return c.json({ deleted: true, wasPrimary: result.isPrimary });
  }
);

app.post(
  '/:id{[0-9]+}/adjust',
  requireBusinessRoutePolicy('inventory.adjust.one'),
  zValidator('json', movementBody.refine((v) => v.qty !== 0, 'Adjust qty cannot be 0')),
  async (c) => {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    // PS-247: a restricted caller may only adjust its own inventory.
    if (!(await inventoryIdInScope(inventoryScopeFromContext(c), id))) {
      return c.json({ error: 'Inventory item not found' }, 404);
    }
    const email = c.get('email' as never) as string | undefined;
    const moveType = body.type ?? 'adjust';
    // PS-324: a movement's direction is a business invariant, not a frontend default —
    // damage/ship/pick can only remove stock. Reject a sign that contradicts the type.
    const dirError = movementDirectionError(moveType, body.qty);
    if (dirError) return c.json({ error: dirError }, 400);
    const identity = movementRequestIdentity(c, `${moveType}:${id}`, body.idempotencyKey);
    const result = await applyMovement({
      inventoryId: id,
      type: moveType,
      qty: body.qty,
      note: body.note,
      createdBy: email ?? 'manual',
      effectiveAt: movementDateFrom(body.adjustedAt ?? body.receivedAt) ?? new Date(),
      ...identity,
    });
    return c.json(result);
  }
);

const bulkReceiveBody = z.object({
  clientId: z.number().int().nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  note: z.string().optional(),
  receivedAt: z.string().datetime().optional(),
  items: z
    .array(
      z.object({
        invSkuId: z.number().int().positive().optional(),
        inventoryId: z.number().int().positive().optional(),
        sku: z.string().trim().optional(),
        name: z.string().trim().optional(),
        // PS-324: `packs` is the operator's pack-count INTENT — the backend expands it to a
        // unit movement qty using the canonical units_per_pack. `qty` (pre-multiplied units)
        // stays accepted for back-compat. Exactly one of packs/qty is required.
        packs: z.number().int().positive().optional(),
        qty: z.number().int().positive().optional(),
        note: z.string().optional(),
      }).refine(
        (item) => item.invSkuId != null || item.inventoryId != null || Boolean(item.sku?.trim()),
        'Each receive item needs an inventory id or SKU'
      ).refine(
        (item) => item.packs != null || item.qty != null,
        'Each receive item needs packs or qty'
      )
    )
    .min(1),
});

async function findOrCreateInventoryForReceive(
  tx: InventoryMovementTransaction | typeof db,
  item: z.infer<typeof bulkReceiveBody>['items'][number],
  clientId: number | null | undefined,
  scope: ClientStoreScope,
  allowCatalogCreate: boolean,
) {
  const requestedId = item.invSkuId ?? item.inventoryId;
  if (requestedId != null) {
    // PS-247: a restricted caller may only receive into an inventory row in its own scope.
    const [row] = await tx
      .select()
      .from(inventory)
      .where(and(eq(inventory.id, requestedId), inventoryScopePredicate(scope)))
      .limit(1);
    if (!row) throw new Error(`Inventory item #${requestedId} not found`);
    return row;
  }

  const sku = item.sku?.trim();
  if (!sku) throw new Error('SKU is required');
  const clientFilter = clientId == null ? isNull(inventory.clientId) : eq(inventory.clientId, clientId);
  const [existing] = await tx
    .select()
    .from(inventory)
    .where(and(clientFilter, sql`lower(${inventory.sku}) = lower(${sku})`))
    .limit(1);
  if (existing) return existing;
  if (!allowCatalogCreate) {
    throw new Error(`Inventory item ${sku} must exist before warehouse receiving`);
  }

  const [created] = await tx
    .insert(inventory)
    .values({
      clientId: clientId ?? null,
      sku,
      name: item.name?.trim() || sku,
    })
    .returning();
  if (!created) throw new Error(`Could not create inventory item for ${sku}`);
  return created;
}

// v2-parity bulk receive: POST /inventory/receive body
// {clientId, note, receivedAt, items:[{sku|invSkuId, qty, name?, note?}]}.
// The entire batch commits or rolls back together so the API cannot report a
// partial receive while leaving only some of the requested movements persisted.
app.post(
  '/receive',
  requireBusinessRoutePolicy('inventory.receive.bulk'),
  zValidator('json', bulkReceiveBody),
  async (c) => {
    const body = c.req.valid('json');
    // PS-247: a restricted caller may only bulk-receive into its own client scope.
    const scope = inventoryScopeFromContext(c);
    if (!inventoryClientInScope(scope, body.clientId)) {
      return c.json({ error: 'Inventory client out of scope' }, 403);
    }
    const email = c.get('email' as never) as string | undefined;
    const allowCatalogCreate = hasInternalAppPermission(
      {
        email,
        role: c.get('role' as never) as string | undefined,
        permissions: c.get('permissions' as never) as string[] | undefined,
      },
      'settings:write',
    );
    const receivedAt = movementDateFrom(body.receivedAt) ?? new Date();
    const batchIdentity = movementRequestIdentity(c, 'receive-batch', body.idempotencyKey);
    const results: Array<{
      invSkuId: number;
      sku?: string | null;
      name?: string | null;
      qty?: number;
      ok: boolean;
      inventoryQuantity?: number;
      ledgerId?: number;
      effectiveAt?: Date | null;
      createdAt?: Date;
      error?: string;
    }> = [];
    try {
      await ensureInventoryLedgerSchema();
      await db.transaction(async (tx) => {
        for (const [itemIndex, item] of body.items.entries()) {
        const inv = await findOrCreateInventoryForReceive(
          tx,
          item,
          body.clientId,
          scope,
          allowCatalogCreate,
        );
        // PS-324: the pack→unit expansion is a persisted MOVEMENT quantity, so the backend owns
        // it from the CANONICAL units_per_pack (the FE sends pack-count intent). Delegated to the
        // resolveReceiveUnits owner; a pre-multiplied `qty` is still honored for back-compat.
        const qty = resolveReceiveUnits(item, inv.unitsPerPack);
        if (qty <= 0) throw new Error(`Receive qty for ${inv.sku} must be greater than 0`);
        const movementIdentity = `${itemIndex}:inventory:${inv.id}`;
        const res = await applyInventoryMovementInTransaction(tx, {
          inventoryId: inv.id,
          type: 'receive',
          qty,
          note: item.note?.trim() || body.note?.trim() || undefined,
          createdBy: email ?? 'manual',
          effectiveAt: receivedAt,
          idempotencyKey: `${batchIdentity.idempotencyKey}:${movementIdentity}`,
          sourceEntity: 'inventory_receive_batch',
          sourceId: `${batchIdentity.sourceId}:${movementIdentity}`,
        });
        results.push({
          invSkuId: inv.id,
          sku: res.inventory?.sku ?? inv.sku,
          name: res.inventory?.name ?? inv.name,
          qty,
          ok: true,
          inventoryQuantity: res.inventory.inventoryQuantity,
          ledgerId: res.ledger?.id,
          effectiveAt: res.ledger?.effectiveAt,
          createdAt: res.ledger?.createdAt,
        });
        }
      });
    } catch (err) {
      return c.json({
        ok: false,
        atomic: true,
        received: [],
        failed: body.items.length,
        total: body.items.length,
        results: [],
        error: err instanceof Error ? err.message : 'Receive batch failed',
      }, 409);
    }
    return c.json({
      ok: true,
      atomic: true,
      received: results,
      failed: 0,
      total: results.length,
      results,
    });
  }
);

// v2-parity single adjust: POST /inventory/adjust body {invSkuId, qty, note?}.
// Same semantic as POST /:id/adjust but v2 shape with id in the body.
app.post(
  '/adjust',
  requireBusinessRoutePolicy('inventory.adjust.body'),
  zValidator(
    'json',
    z.object({
      invSkuId: z.number().int().positive(),
      qty: z.number().int().refine((v) => v !== 0, 'qty cannot be 0'),
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
      note: z.string().optional(),
      type: z.enum(['receive', 'adjust', 'pick', 'ship', 'return', 'damage']).optional(),
      adjustedAt: z.string().datetime().optional(),
      receivedAt: z.string().datetime().optional(),
    })
  ),
  async (c) => {
    const body = c.req.valid('json');
    // PS-247: a restricted caller may only adjust its own inventory.
    if (!(await inventoryIdInScope(inventoryScopeFromContext(c), body.invSkuId))) {
      return c.json({ error: 'Inventory item not found' }, 404);
    }
    const email = c.get('email' as never) as string | undefined;
    const moveType = body.type ?? 'adjust';
    // PS-324: enforce the movement-direction invariant (damage/ship/pick must remove stock).
    const dirError = movementDirectionError(moveType, body.qty);
    if (dirError) return c.json({ error: dirError }, 400);
    const identity = movementRequestIdentity(c, `${moveType}:${body.invSkuId}`, body.idempotencyKey);
    const result = await applyMovement({
      inventoryId: body.invSkuId,
      type: moveType,
      qty: body.qty,
      note: body.note,
      createdBy: email ?? 'manual',
      effectiveAt: movementDateFrom(body.adjustedAt ?? body.receivedAt) ?? new Date(),
      ...identity,
    });
    return c.json(result);
  }
);

// Bulk update of dimensions + pack-size fields for many inventory rows in one call.
// Extended for v2 parity: baseUnitQty, unitsPerPack, cuFtOverride, packageId — so
// CSV importers and bulk editors can populate the new pack-size fields without
// per-row PATCH round-trips.
const bulkDimsBody = z.object({
  items: z
    .array(
      z.object({
        id: z.number().int().positive(),
        weightOz: z.number().nonnegative().optional(),
        length: z.number().nonnegative().optional(),
        width: z.number().nonnegative().optional(),
        height: z.number().nonnegative().optional(),
        baseUnitQty: z.number().int().positive().optional(),
        unitsPerPack: z.number().int().positive().optional(),
        cuFtOverride: z.number().nonnegative().nullable().optional(),
        packageId: z.number().int().positive().nullable().optional(),
      })
    )
    .min(1)
    .max(500),
});

// v2-parity: POST /inventory/bulk-set-default-package
// {clientId, packageId, skus[]} — sets inventory.package_id for many SKUs in
// one call. Fired by the shipping panel when an auto-detected package can't be
// saved through the single-SKU savePanelSkuDefaults path (multi-SKU orders),
// so the same default package lands on every line item rather than only on
// single-SKU orders. clientId is required when scoping to a tenant; pass null
// to update the shared (clientId IS NULL) catalog rows.
const bulkSetPackageBody = z.object({
  clientId: z.number().int().nullable(),
  packageId: z.number().int().positive().nullable(),
  skus: z.array(z.string().trim().min(1)).min(1).max(200),
});

app.post(
  '/bulk-set-default-package',
  requireBusinessRoutePolicy('inventory.catalog.bulk-default-package'),
  zValidator('json', bulkSetPackageBody),
  async (c) => {
    const { clientId, packageId, skus } = c.req.valid('json');
    // PS-247: a restricted caller may only set defaults within its own client scope.
    if (!inventoryClientInScope(inventoryScopeFromContext(c), clientId)) {
      return c.json({ error: 'Inventory client out of scope' }, 403);
    }
    let updated = 0;
    for (const rawSku of skus) {
      const sku = rawSku.trim();
      if (!sku) continue;
      const skuWhere = sql`lower(${inventory.sku}) = lower(${sku})`;
      const where = and(
        skuWhere,
        clientId === null ? isNull(inventory.clientId) : eq(inventory.clientId, clientId)
      );
      const rows = await db
        .update(inventory)
        .set({ packageId, updatedAt: new Date() })
        .where(where)
        .returning({ id: inventory.id });
      updated += rows.length;
    }
    return c.json({
      updated,
      skipped: skus.length - updated,
      total: skus.length,
    });
  }
);

app.post(
  '/bulk-update-dims',
  requireBusinessRoutePolicy('inventory.catalog.bulk-dimensions'),
  zValidator('json', bulkDimsBody),
  async (c) => {
  const { items } = c.req.valid('json');
  // PS-247: out-of-scope rows fall outside the predicate -> not updated (counted as skipped).
  const scope = inventoryScopeFromContext(c);
  let updated = 0;
  for (const item of items) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (item.weightOz !== undefined) patch.weightOz = item.weightOz;
    if (item.length !== undefined) patch.length = item.length;
    if (item.width !== undefined) patch.width = item.width;
    if (item.height !== undefined) patch.height = item.height;
    if (item.baseUnitQty !== undefined) patch.baseUnitQty = item.baseUnitQty;
    if (item.unitsPerPack !== undefined) patch.unitsPerPack = item.unitsPerPack;
    if (item.cuFtOverride !== undefined) patch.cuFtOverride = item.cuFtOverride;
    if (item.packageId !== undefined) patch.packageId = item.packageId;
    const [row] = await db
      .update(inventory)
      .set(patch)
      .where(and(eq(inventory.id, item.id), inventoryScopePredicate(scope)))
      .returning({ id: inventory.id });
    if (row) updated += 1;
  }
  return c.json({
    updated,
    skipped: items.length - updated,
    message: `Updated ${updated} of ${items.length} items`,
  });
  },
);

// Scan orders.items JSONB and seed inventory rows for any SKU we don't
// have yet (clientId set from the order's clientId, or null if order is
// unassigned). Useful as a quick way to populate inventory from the
// orders that already synced from ShipStation.
//
// 2026-05-13: extracted to src/services/inventory-enrichment.ts so the
// in-process scheduler can call the same logic on a 30-min interval.
// This route handler is now a thin wrapper that the Inventory toolbar's
// "📥 Import SKUs from Orders" button still drives manually.
app.post(
  '/import-from-orders',
  requireBusinessRoutePolicy('inventory.catalog.import-orders'),
  async (c) => {
  const result = await importSkusFromOrders();
  return c.json(result);
  },
);

// Pull product catalog from ShipStation v1 /products (every account we
// know about) and upsert as inventory rows. Quantity stays ledger-derived — the
// standard SS API doesn't expose stock levels. Matching:
//   • Main account products → clientId IS NULL (shared catalog)
//   • Per-client accounts (e.g. KFG) → clientId = account owner
// so each client's product catalog lands on its own row and pulls its
// ShipStation thumbnail + dims + weight.
//
// 2026-05-13: extracted to src/services/inventory-enrichment.ts so the
// in-process scheduler can fire this hourly. This route handler is the
// manual path — the "📐 Import Dims from SS" toolbar button still
// drives it on demand.
app.post(
  '/sync-products',
  requireBusinessRoutePolicy('inventory.catalog.sync-products'),
  async (c) => {
  const result = await syncShipStationProducts();
  return c.json(result);
  },
);

export default app;
