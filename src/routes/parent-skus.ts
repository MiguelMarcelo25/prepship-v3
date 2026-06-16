import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { requireInternalPermission } from '../middleware/auth';
import { activeClientPredicateSql } from '../lib/active-client-predicate';
import { parentSkus } from '../db/schema/parent-skus';
import { inventory } from '../db/schema/inventory';
import { clients } from '../db/schema/clients';

const app = new Hono();

const listQ = z.object({
  clientId: z.coerce.number().int().optional(),
  // Admin escape hatch — when true, returns parent SKUs from
  // disabled clients too. Default behavior (omitted/false) keeps
  // operators in dropdowns + assignment flows from ever seeing a
  // parent SKU whose owning client is disabled.
  includeInactive: z.coerce.boolean().optional(),
});

// 2026-05-13 visibility hardening: parent_skus has a clientId column
// but the original list query never filtered on the owning client's
// `active` flag — so disabled clients' parent SKUs were leaking into
// the "Assign parent SKU" dropdown on the Inventory page. Filter via
// EXISTS against the clients table, mirroring the predicate used by
// activeInventoryClientPredicate in routes/inventory.ts. Rows with
// NULL client_id stay visible (legacy / unassigned), same lenient
// policy as the rest of the codebase.
const activeParentSkuClientPredicate = sql`(
  ${parentSkus.clientId} is null
  or exists (
    select 1 from ${clients} owner_client
    where owner_client.id = ${parentSkus.clientId}
      and ${sql.raw(activeClientPredicateSql('owner_client'))}
  )
)`;

app.get('/', zValidator('query', listQ), async (c) => {
  const { clientId, includeInactive } = c.req.valid('query');
  const where = and(
    ...[
      clientId !== undefined ? eq(parentSkus.clientId, clientId) : undefined,
      includeInactive ? undefined : activeParentSkuClientPredicate,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );
  const rows = await db
    .select()
    .from(parentSkus)
    .where(where)
    .orderBy(asc(parentSkus.name));
  return c.json({ data: rows });
});

const createBody = z.object({
  clientId: z.number().int().positive(),
  name: z.string().min(1),
  sku: z.string().nullable().optional(),
  baseUnitQty: z.number().int().positive().optional(),
});

// PS-252 (Card 7): parent-SKU catalog mutations are internal config — gate writes behind
// settings:write (matching products/locations/clients). Reads (list + detail) stay open.
app.post('/', requireInternalPermission('settings:write'), zValidator('json', createBody), async (c) => {
  const body = c.req.valid('json');
  const [row] = await db.insert(parentSkus).values(body).returning();
  return c.json(row, 201);
});

app.patch(
  '/:id{[0-9]+}',
  requireInternalPermission('settings:write'),
  zValidator('json', createBody.partial()),
  async (c) => {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    const [row] = await db
      .update(parentSkus)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(parentSkus.id, id))
      .returning();
    if (!row) return c.json({ error: 'Parent SKU not found' }, 404);
    return c.json(row);
  }
);

// v2-parity: GET /parent-skus/:id/detail
// Returns aggregated ParentSkuDetailDto: `{parent, children, lowStockChildren,
// lowStockCount}`. Replaces the React client's N+1 (fetch parent + list
// inventory + filter) with a single server-assembled payload. Low-stock
// filter: inventory rows where stock_qty <= reorder_level (v2 uses the same
// threshold semantics via base_units <= min_stock).
app.get('/:id{[0-9]+}/detail', async (c) => {
  const id = Number(c.req.param('id'));
  const [parent] = await db
    .select()
    .from(parentSkus)
    .where(eq(parentSkus.id, id))
    .limit(1);
  if (!parent) return c.json({ error: 'Parent SKU not found' }, 404);

  const children = await db
    .select()
    .from(inventory)
    .where(eq(inventory.parentSkuId, id))
    .orderBy(asc(inventory.sku));

  const lowStockChildren = children.filter(
    (c) => c.stockQty <= c.reorderLevel
  );

  return c.json({
    parent,
    children,
    lowStockChildren,
    lowStockCount: lowStockChildren.length,
  });
});

app.delete('/:id{[0-9]+}', requireInternalPermission('settings:write'), async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db
    .delete(parentSkus)
    .where(eq(parentSkus.id, id))
    .returning();
  if (!row) return c.json({ error: 'Parent SKU not found' }, 404);
  return c.json({ deleted: true });
});

export default app;
