import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { products, type Product } from '../../db/schema/products.js';

/**
 * Canonical owner of the products.hazmat write.
 *
 * The route used to hold this select-then-update/insert itself, which pushed
 * src/routes/products.ts from 7 route-local writes to 9 and tripped the PS-464
 * shrinking ratchet. That ratchet exists because product persistence belongs
 * behind a product command owner, not inside an HTTP handler -- so the fix is
 * to move the write, not to raise the number.
 *
 * Addressed by SKU because the caller that needs it (the Inventory SKU editor)
 * knows a sku, not a product id. Matching is normalised (trim + upper) since
 * catalog and inventory rows disagree about SKU casing.
 *
 * Upserts: an inventory row can exist for a SKU with no catalog row yet, and a
 * checkbox that silently does nothing is worse than creating a bare product to
 * carry the flag.
 *
 * Scope note: this sets ONE column. It deliberately cannot touch name, dims or
 * package code, so an operator ticking a checkbox can never overwrite catalog
 * data as a side effect.
 */
export async function setProductHazmatBySku(input: {
  sku: string;
  hazmat: boolean;
}): Promise<{ product: Product; created: boolean }> {
  const sku = input.sku.trim();
  if (!sku) throw new Error('SKU required');

  const [existing] = await db
    .select({ id: products.id })
    .from(products)
    .where(sql`upper(btrim(${products.sku})) = upper(btrim(${sku}))`)
    .limit(1);

  if (existing) {
    const [product] = await db
      .update(products)
      .set({ hazmat: input.hazmat, updatedAt: new Date() })
      .where(eq(products.id, existing.id))
      .returning();
    // The row was selected moments ago; a concurrent delete is the only way
    // this returns nothing, and saying so beats returning undefined.
    if (!product) throw new Error('Product was removed while updating its hazmat flag');
    return { product, created: false };
  }

  const [product] = await db
    .insert(products)
    .values({ sku, hazmat: input.hazmat })
    .returning();
  if (!product) throw new Error('Could not create the product for this SKU');
  return { product, created: true };
}
