import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory } from '../db/schema/inventory';
import { orderItems } from '../db/schema/order-items';
import { orderOverrides, orders } from '../db/schema/orders';
import { products } from '../db/schema/products';
import { normalizeComboItems, type ComboItemInput } from '../lib/package-combo';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';

const app = new Hono();

const listQ = paginationSchema.extend({
  search: z.string().optional(),
});

app.get('/', zValidator('query', listQ), async (c) => {
  const q = c.req.valid('query');
  const where = q.search
    ? or(
        ilike(products.sku, `%${q.search}%`),
        ilike(products.name, `%${q.search}%`)
      )
    : undefined;

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(products)
      .where(where)
      .orderBy(desc(products.updatedAt))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(where),
  ]);

  return c.json(paginated(rows, countRows[0]?.count ?? 0, q));
});

const bulkQ = z.object({
  skus: z.string().min(1),
});

app.get('/bulk', zValidator('query', bulkQ), async (c) => {
  const skus = c.req
    .valid('query')
    .skus.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!skus.length) return c.json({ data: [] });
  const rows = await db
    .select()
    .from(products)
    .where(inArray(products.sku, skus))
    .orderBy(asc(products.sku));
  return c.json({ data: rows });
});

app.get('/by-sku/:sku', async (c) => {
  const sku = c.req.param('sku');
  const [row] = await db.select().from(products).where(eq(products.sku, sku)).limit(1);
  if (!row) return c.json(null);
  return c.json(row);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (!row) return c.json({ error: 'Product not found' }, 404);
  return c.json(row);
});

const body = z.object({
  sku: z.string().min(1).optional(),
  name: z.string().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  weightOz: z.number().nonnegative().optional(),
  length: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  defaultPackageCode: z.string().nullable().optional(),
});

app.post('/', zValidator('json', body.required({ sku: true })), async (c) => {
  const v = c.req.valid('json');
  const [row] = await db.insert(products).values(v).returning();
  return c.json(row, 201);
});

app.patch('/:id{[0-9]+}', zValidator('json', body), async (c) => {
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(products)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(products.id, id))
    .returning();
  if (!row) return c.json({ error: 'Product not found' }, 404);
  return c.json(row);
});

// Save defaults (upsert by SKU) — back-compat with the old /products/save-defaults
const saveDefaultsBody = z.object({
  sku: z.string().min(1),
  name: z.string().nullable().optional(),
  clientId: z.number().int().positive().nullable().optional(),
  weightOz: z.number().nonnegative().optional(),
  length: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  defaultPackageCode: z.string().nullable().optional(),
});

async function loadSingleSkuCandidateItems(orderId: number, fallbackItems: unknown): Promise<ComboItemInput[]> {
  const rows = await db
    .select({ sku: orderItems.sku, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  if (rows.length) return rows.map((row) => ({ sku: row.sku, quantity: row.quantity }));
  return Array.isArray(fallbackItems) ? (fallbackItems as ComboItemInput[]) : [];
}

function selectedPackageIdFromProductDefault(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

async function applySingleSkuDefaultsToMatchingMutableOrders(input: {
  sku: string;
  clientId?: number | null;
  weightOz?: number;
  length?: number;
  width?: number;
  height?: number;
  defaultPackageCode?: string | null;
}): Promise<number> {
  if (input.clientId === undefined) return 0;
  const normalizedSku = input.sku.trim().toLowerCase();
  if (!normalizedSku) return 0;

  const candidates = await db
    .select({ id: orders.id, items: orders.items })
    .from(orders)
    .where(
      and(
        input.clientId === null ? isNull(orders.clientId) : eq(orders.clientId, input.clientId),
        eq(orders.orderStatus, 'awaiting_shipment'),
      ),
    );

  let appliedMutableOrderCount = 0;
  const selectedPackageId = selectedPackageIdFromProductDefault(input.defaultPackageCode);
  const perUnitWeightOz =
    typeof input.weightOz === 'number' && Number.isFinite(input.weightOz) && input.weightOz > 0
      ? input.weightOz
      : null;

  for (const candidate of candidates) {
    const items = await loadSingleSkuCandidateItems(candidate.id, candidate.items);
    const normalizedItems = normalizeComboItems(items);
    if (normalizedItems.length !== 1 || normalizedItems[0]?.sku !== normalizedSku) continue;
    const qty = normalizedItems[0]?.qty ?? 1;
    const rateWeightOz = perUnitWeightOz != null
      ? Number((perUnitWeightOz * qty).toFixed(2))
      : null;

    await db
      .insert(orderOverrides)
      .values({
        orderId: candidate.id,
        selectedPackageId,
        rateDimsL: input.length ?? null,
        rateDimsW: input.width ?? null,
        rateDimsH: input.height ?? null,
        rateWeightOz,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: orderOverrides.orderId,
        set: {
          selectedPackageId,
          rateDimsL: input.length ?? null,
          rateDimsW: input.width ?? null,
          rateDimsH: input.height ?? null,
          rateWeightOz,
          updatedAt: new Date(),
        },
      });
    appliedMutableOrderCount += 1;
  }

  return appliedMutableOrderCount;
}

app.post('/save-defaults', zValidator('json', saveDefaultsBody), async (c) => {
  const v = c.req.valid('json');
  const { clientId: inventoryClientId, ...productValues } = v;
  const [row] = await db
    .insert(products)
    .values(productValues)
    .onConflictDoUpdate({
      target: products.sku,
      set: {
        name: productValues.name,
        weightOz: productValues.weightOz,
        length: productValues.length,
        width: productValues.width,
        height: productValues.height,
        defaultPackageCode: productValues.defaultPackageCode,
        updatedAt: new Date(),
      },
    })
    .returning();

  // v2-parity: also mirror into the dedicated product_defaults table so v2
  // integrations reading that table see the same data. Canonical store is
  // still `products` — the mirror is best-effort.
  try {
    const { productDefaults } = await import('../db/schema/product-defaults');
    const toStr = (n: number | null | undefined) =>
      n == null ? null : String(n);
    await db
      .insert(productDefaults)
      .values({
        sku: v.sku,
        weightOz: toStr(v.weightOz),
        length: toStr(v.length),
        width: toStr(v.width),
        height: toStr(v.height),
        defaultPackageCode: v.defaultPackageCode ?? null,
      })
      .onConflictDoUpdate({
        target: productDefaults.sku,
        set: {
          weightOz: toStr(v.weightOz),
          length: toStr(v.length),
          width: toStr(v.width),
          height: toStr(v.height),
          defaultPackageCode: v.defaultPackageCode ?? null,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.warn('[products] product_defaults mirror failed:', err);
  }

  // Keep Inventory in sync with shipping/product defaults. The inventory grid
  // reads from inventory.*, not products.*, so SKU-level package auto-detection
  // in the shipping panel needs to land here too.
  try {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (v.name !== undefined && v.name !== null) patch.name = v.name;
    if (v.weightOz !== undefined) patch.weightOz = v.weightOz;
    if (v.length !== undefined) patch.length = v.length;
    if (v.width !== undefined) patch.width = v.width;
    if (v.height !== undefined) patch.height = v.height;

    if (v.defaultPackageCode === null) {
      patch.packageId = null;
    } else if (typeof v.defaultPackageCode === 'string') {
      const packageId = Number.parseInt(v.defaultPackageCode, 10);
      if (Number.isFinite(packageId) && packageId > 0) patch.packageId = packageId;
    }

    const skuWhere = sql`lower(${inventory.sku}) = lower(${v.sku})`;
    const where =
      inventoryClientId === undefined
        ? skuWhere
        : and(
            skuWhere,
            inventoryClientId === null ? isNull(inventory.clientId) : eq(inventory.clientId, inventoryClientId)
          );

    await db.update(inventory).set(patch).where(where);
  } catch (err) {
    console.warn('[products] inventory defaults mirror failed:', err);
  }

  const appliedMutableOrderCount = await applySingleSkuDefaultsToMatchingMutableOrders({
    sku: v.sku,
    clientId: inventoryClientId,
    weightOz: v.weightOz,
    length: v.length,
    width: v.width,
    height: v.height,
    defaultPackageCode: v.defaultPackageCode,
  });

  return c.json({ ...row, appliedMutableOrderCount });
});

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(products).where(eq(products.id, id)).returning();
  if (!row) return c.json({ error: 'Product not found' }, 404);
  return c.json({ deleted: true });
});

export default app;
