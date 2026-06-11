/**
 * PS-177 (Phase 5, part 3) — backend-owned shipment dims/package DEFAULTS for
 * an order, attached to the detail payload as `dimsDefaults` (the PS-037
 * comboPackageDefault pattern). Replaces the FE's N-per-panel
 * /products/by-sku fetch loop + client-side stacking derivation with ONE
 * server-side resolution from the same product/inventory truth.
 *
 * Read-only: queries products / inventory / order_items / orders. Display +
 * panel-seeding defaults only — saving dims still goes through the existing
 * guarded save-dims routes.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory } from '../db/schema/inventory';
import { orderItems } from '../db/schema/order-items';
import { orders } from '../db/schema/orders';
import { products } from '../db/schema/products';
import {
  deriveShipmentDimsFromProductDefaults,
  type DerivedShipmentDims,
  type DimsDefaultItem,
} from './order-dims-defaults-policy';

/**
 * The /products/by-sku lookup, extracted so the route and the order-level
 * dims-defaults resolver share ONE rule: exact products row first, then the
 * Inventory fallback preferring complete shipping defaults, then global rows,
 * then recency. Byte-identical to the route's historical response shapes.
 */
export async function findProductDefaultsBySku(sku: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(products).where(eq(products.sku, sku)).limit(1);
  if (row) return row as Record<string, unknown>;

  const [inventoryRow] = await db
    .select({
      sku: inventory.sku,
      name: inventory.name,
      weightOz: inventory.weightOz,
      length: inventory.length,
      width: inventory.width,
      height: inventory.height,
      packageId: inventory.packageId,
    })
    .from(inventory)
    .where(and(eq(sql`lower(${inventory.sku})`, sku.trim().toLowerCase()), eq(inventory.active, true)))
    .orderBy(sql`
      case
        when coalesce(${inventory.weightOz}, 0) > 0
          and coalesce(${inventory.length}, 0) > 0
          and coalesce(${inventory.width}, 0) > 0
          and coalesce(${inventory.height}, 0) > 0
        then 0
        else 1
      end,
      case when ${inventory.clientId} is null then 0 else 1 end,
      ${inventory.updatedAt} desc
    `)
    .limit(1);

  if (!inventoryRow) return null;
  return {
    sku: inventoryRow.sku,
    name: inventoryRow.name,
    weightOz: inventoryRow.weightOz ?? 0,
    length: inventoryRow.length ?? 0,
    width: inventoryRow.width ?? 0,
    height: inventoryRow.height ?? 0,
    defaultPackageCode: inventoryRow.packageId == null ? null : String(inventoryRow.packageId),
    packageId: inventoryRow.packageId ?? null,
    source: 'inventory',
  };
}

export type OrderDimsDefaultsDto = {
  /** Stacked parcel derivation — null unless EVERY sku'd line has complete defaults. */
  dims: DerivedShipmentDims | null;
  /** Product default weight — single-SKU orders only (FE parity). */
  weightOz: number | null;
  /** Product default package — single-SKU orders only (FE parity). */
  defaultPackageCode: string | null;
  packageId: number | null;
  skuCount: number;
  source: 'product_defaults';
};

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function loadSkuLines(orderId: number, fallbackItems: unknown): Promise<DimsDefaultItem[]> {
  // Canonical per-line table first; raw orders.items jsonb as the import fallback
  // (the loadComboItems pattern). Adjustment lines and sku-less lines are not
  // dims-derivable and are excluded, mirroring the panel's getActiveItems filter.
  const rows = await db
    .select({ sku: orderItems.sku, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const lines: Array<Record<string, unknown>> = rows.length
    ? rows.map((r) => ({ sku: r.sku, quantity: r.quantity }))
    : Array.isArray(fallbackItems)
      ? (fallbackItems as Array<Record<string, unknown>>)
      : [];
  return lines
    .filter((line) => line && typeof line === 'object' && !line.adjustment)
    .map((line) => ({ sku: typeof line.sku === 'string' ? line.sku : null, quantity: Number(line.quantity) || 1 }))
    .filter((line) => Boolean(line.sku && line.sku.trim()));
}

/**
 * Resolve the order's dims/weight/package DEFAULTS from product data. Null when
 * the order has no sku'd lines or nothing resolvable. Best-effort: any failure
 * returns null so the detail payload never breaks on an additive display field.
 */
export async function getOrderDimsDefaultsForOrder(orderId: number): Promise<OrderDimsDefaultsDto | null> {
  try {
    const [ord] = await db
      .select({ items: orders.items })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!ord) return null;

    const skuLines = await loadSkuLines(orderId, ord.items);
    if (!skuLines.length) return null;
    const uniqueSkus = [...new Set(skuLines.map((line) => String(line.sku).trim()))];

    const lookups = await Promise.all(
      uniqueSkus.map(async (sku) => ({ sku, payload: await findProductDefaultsBySku(sku) })),
    );
    const defaultsBySku = new Map<string, Record<string, unknown>>();
    for (const lookup of lookups) {
      if (lookup.payload) defaultsBySku.set(lookup.sku.toLowerCase(), lookup.payload);
    }

    const dims = deriveShipmentDimsFromProductDefaults(skuLines, defaultsBySku);
    // Single-SKU orders also seed weight + default package from that product —
    // multi-SKU combos never guess a single product's weight/package (FE parity).
    const singleSkuProduct =
      uniqueSkus.length === 1 ? defaultsBySku.get(uniqueSkus[0]!.toLowerCase()) ?? null : null;
    const weightOz = positiveNumber(singleSkuProduct?.weightOz);
    const defaultPackageCode =
      typeof singleSkuProduct?.defaultPackageCode === 'string' && singleSkuProduct.defaultPackageCode.trim()
        ? singleSkuProduct.defaultPackageCode.trim()
        : null;
    const packageId = positiveNumber(singleSkuProduct?.packageId);

    if (!dims && weightOz == null && !defaultPackageCode && packageId == null) return null;
    return {
      dims,
      weightOz,
      defaultPackageCode,
      packageId: packageId != null ? Math.trunc(packageId) : null,
      skuCount: uniqueSkus.length,
      source: 'product_defaults',
    };
  } catch (err) {
    console.warn(
      '[order-dims-defaults] resolution skipped:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
