import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orderItems } from '../../db/schema/order-items.js';
import { products } from '../../db/schema/products.js';

/**
 * Which of an order's SKUs are flagged as dangerous goods in the catalog.
 *
 * Read-only, and deliberately NOT a declaration. It answers "this line is a
 * regulated item", never "this shipment is declared hazmat" -- that stays
 * order_hazmat_declarations, with its own revision, audit trail and canary
 * gating. An order can have a hazmat SKU and no declaration, which is exactly
 * the state an operator needs to be able to see.
 *
 * Computed on the backend rather than joined in the panel: orders.items is
 * denormalised JSONB copied from the marketplace and carries no catalog data,
 * so the frontend would otherwise have to fetch products per SKU and decide the
 * match itself.
 *
 * Matching is normalised (trim + upper) because marketplace item payloads are
 * not consistent about SKU casing or padding, and products.sku is the catalog's
 * own spelling.
 */
export async function loadOrderHazmatSkus(orderId: number): Promise<string[]> {
  const rows = await db
    .select({ sku: products.sku })
    .from(orderItems)
    .innerJoin(
      products,
      sql`upper(btrim(${products.sku})) = upper(btrim(${orderItems.sku}))`,
    )
    .where(and(eq(orderItems.orderId, orderId), eq(products.hazmat, true)));

  // The panel matches its line SKUs against this, so return the catalog
  // spelling de-duplicated -- an order can list the same SKU on more than one
  // line.
  return [...new Set(rows.map((row) => row.sku).filter((sku): sku is string => sku != null))];
}

/**
 * Same question for many orders at once, for list reads that would otherwise
 * issue one query per row.
 */
export async function loadHazmatSkusForOrders(
  orderIds: readonly number[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  if (orderIds.length === 0) return result;

  const rows = await db
    .select({ orderId: orderItems.orderId, sku: products.sku })
    .from(orderItems)
    .innerJoin(
      products,
      sql`upper(btrim(${products.sku})) = upper(btrim(${orderItems.sku}))`,
    )
    .where(and(inArray(orderItems.orderId, [...orderIds]), eq(products.hazmat, true)));

  for (const row of rows) {
    if (row.sku == null) continue;
    const existing = result.get(row.orderId);
    if (existing) {
      if (!existing.includes(row.sku)) existing.push(row.sku);
    } else {
      result.set(row.orderId, [row.sku]);
    }
  }
  return result;
}
