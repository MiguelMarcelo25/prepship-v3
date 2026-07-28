import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
// PS-252 (Card 7): the product (SKU) catalog is global config — only internal staff with
// settings:write may mutate it; a portal/client_user must not edit the shared catalog.
import { requireInternalPermission } from '../middleware/auth';
import { inventory } from '../db/schema/inventory';
import { orderItems } from '../db/schema/order-items';
import { orderOverrides, orders } from '../db/schema/orders';
import { products } from '../db/schema/products';
import { normalizeComboItems, type ComboItemInput } from '../lib/package-combo';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';
import {
  computeOrderRateJobFingerprint,
  setOrderRatePending,
} from '../services/shipping-workflow/order-rate-job-status';
import { enqueueBackfillBestRatesForOrderIds } from '../services/rates-backfill';
import { findProductDefaultsBySku } from '../services/order-dims-defaults';

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
  // PS-177 (Phase 5): the products-then-inventory defaults lookup moved to
  // order-dims-defaults.findProductDefaultsBySku so this route and the order
  // detail dimsDefaults resolver share ONE rule. Response shape unchanged.
  const sku = c.req.param('sku');
  return c.json(await findProductDefaultsBySku(sku));
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
  // Catalog fact only. Setting it declares nothing -- order hazmat still comes
  // from order_hazmat_declarations via the gated hazmat write path.
  hazmat: z.boolean().optional(),
});

app.post('/', requireInternalPermission('settings:write'), zValidator('json', body.required({ sku: true })), async (c) => {
  const v = c.req.valid('json');
  const [row] = await db.insert(products).values(v).returning();
  return c.json(row, 201);
});

app.patch('/:id{[0-9]+}', requireInternalPermission('settings:write'), zValidator('json', body), async (c) => {
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
  // The qty of the order this default was saved from. When present, the
  // weight/dims push only touches awaiting single-SKU orders with the SAME
  // qty, so saving a 1-pack default never changes a 2-pack order (whose box
  // size differs). Omitted = legacy behavior (apply across all quantities).
  appliesToQty: z.number().int().positive().optional(),
  // PS-121: explicit "Save weights & dims as SKU defaults" sets this true so the backend
  // invalidates + targeted-recalcs the same SKU+qty group's stale sibling rates. Silent
  // autosave omits it (default false) → propagate dims only, never touch saved rates.
  recalcGroup: z.boolean().optional(),
});

// PS-121 — numeric equality tolerant of null + real-column string/number drift.
function numEqProduct(a: unknown, b: unknown): boolean {
  const na = a == null ? null : Number(a);
  const nb = b == null ? null : Number(b);
  if (na == null && nb == null) return true;
  if (na == null || nb == null) return false;
  return Math.abs(na - nb) < 1e-9;
}

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
  // When set, only push to awaiting single-SKU orders with this exact qty, so a
  // saved default for one qty never overwrites another qty's weight/box.
  appliesToQty?: number | null;
  // PS-121: when true (explicit save), invalidate + collect siblings whose dims/weight/package
  // changed and that have a saved rate, so the caller can targeted-recalc them.
  recalcGroup?: boolean;
}): Promise<{ appliedMutableOrderCount: number; affectedOrderIds: number[] }> {
  if (input.clientId === undefined) return { appliedMutableOrderCount: 0, affectedOrderIds: [] };
  const normalizedSku = input.sku.trim().toLowerCase();
  if (!normalizedSku) return { appliedMutableOrderCount: 0, affectedOrderIds: [] };

  // Pull ship-to + base weight + raw (for the PS-120 fingerprint) + current override
  // dims/weight/package + whether a saved rate exists (to detect change). awaiting_shipment
  // filter is the lockdown gate — shipped/cancelled never touched.
  const candidates = await db
    .select({
      id: orders.id,
      items: orders.items,
      weightOz: orders.weightOz,
      shipToPostalCode: orders.shipToPostalCode,
      shipToState: orders.shipToState,
      shipToCity: orders.shipToCity,
      raw: orders.raw,
      curDimsL: orderOverrides.rateDimsL,
      curDimsW: orderOverrides.rateDimsW,
      curDimsH: orderOverrides.rateDimsH,
      curWeightOz: orderOverrides.rateWeightOz,
      curPackageId: orderOverrides.selectedPackageId,
      curBestRateAt: orderOverrides.bestRateAt,
    })
    .from(orders)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(
      and(
        input.clientId === null ? isNull(orders.clientId) : eq(orders.clientId, input.clientId),
        eq(orders.orderStatus, 'awaiting_shipment'),
      ),
    );

  let appliedMutableOrderCount = 0;
  const affectedOrderIds: number[] = [];
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
    // Scope to the saving order's qty: a 1-pack default must not change a
    // 2-pack order (different box), and vice versa.
    if (input.appliesToQty != null && qty !== input.appliesToQty) continue;
    const rateWeightOz = perUnitWeightOz != null
      ? Number((perUnitWeightOz * qty).toFixed(2))
      : null;

    // PS-121: invalidate a sibling's saved rate only when this explicit save actually CHANGED
    // its dims/weight/package AND it has a saved rate. Silent autosave (recalcGroup=false)
    // propagates dims exactly as before and never touches saved rates.
    const dimsOrPackageChanged =
      !numEqProduct(candidate.curDimsL, input.length ?? null) ||
      !numEqProduct(candidate.curDimsW, input.width ?? null) ||
      !numEqProduct(candidate.curDimsH, input.height ?? null) ||
      !numEqProduct(candidate.curWeightOz, rateWeightOz) ||
      (candidate.curPackageId ?? null) !== selectedPackageId;
    const invalidate =
      input.recalcGroup === true && candidate.curBestRateAt != null && dimsOrPackageChanged;

    const set = {
      selectedPackageId,
      rateDimsL: input.length ?? null,
      rateDimsW: input.width ?? null,
      rateDimsH: input.height ?? null,
      rateWeightOz,
      updatedAt: new Date(),
      ...(invalidate ? { bestRateJson: null, bestRateAt: null, bestRateDims: null } : {}),
    };

    await db
      .insert(orderOverrides)
      .values({ orderId: candidate.id, ...set })
      .onConflictDoUpdate({ target: orderOverrides.orderId, set });
    appliedMutableOrderCount += 1;

    if (invalidate) {
      affectedOrderIds.push(candidate.id);
      try {
        await setOrderRatePending(
          candidate.id,
          computeOrderRateJobFingerprint({
            orderId: candidate.id,
            weightOz: candidate.weightOz,
            shipToPostalCode: candidate.shipToPostalCode,
            shipToState: candidate.shipToState,
            shipToCity: candidate.shipToCity,
            rateDimsL: input.length ?? null,
            rateDimsW: input.width ?? null,
            rateDimsH: input.height ?? null,
            raw: candidate.raw,
          }),
        );
      } catch (err) {
        console.warn(
          '[products] failed to stamp pending rate-job:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return { appliedMutableOrderCount, affectedOrderIds };
}

app.post('/save-defaults', requireInternalPermission('settings:write'), zValidator('json', saveDefaultsBody), async (c) => {
  const v = c.req.valid('json');
  // appliesToQty governs the per-order push scope only — it is not a `products`
  // column, so keep it out of the upsert values.
  const { clientId: inventoryClientId, appliesToQty: _appliesToQty, ...productValues } = v;
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

  const { appliedMutableOrderCount, affectedOrderIds } =
    await applySingleSkuDefaultsToMatchingMutableOrders({
      sku: v.sku,
      clientId: inventoryClientId,
      weightOz: v.weightOz,
      length: v.length,
      width: v.width,
      height: v.height,
      defaultPackageCode: v.defaultPackageCode,
      appliesToQty: v.appliesToQty ?? null,
      recalcGroup: v.recalcGroup === true,
    });

  // PS-121: explicit save → targeted recalc of exactly the invalidated siblings (awaiting only).
  if (v.recalcGroup === true && affectedOrderIds.length) {
    await enqueueBackfillBestRatesForOrderIds(affectedOrderIds);
  }

  return c.json({ ...row, appliedMutableOrderCount, affectedOrderIds });
});

app.delete('/:id{[0-9]+}', requireInternalPermission('settings:write'), async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(products).where(eq(products.id, id)).returning();
  if (!row) return c.json({ error: 'Product not found' }, 404);
  return c.json({ deleted: true });
});

export default app;
