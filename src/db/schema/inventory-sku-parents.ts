import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { inventory } from './inventory.js';
import { parentSkus } from './parent-skus.js';

// v2-parity: multi-parent SKU membership. One inventory row can belong to
// many parent bundles (and vice versa). v4 previously modeled this as a
// single parentSkuId FK on inventory; keeping that column as "primary parent"
// for backward compat while routing new multi-parent assignments through
// this join table.
export const inventorySkuParents = pgTable(
  'inventory_sku_parents',
  {
    inventoryId: integer()
      .notNull()
      .references(() => inventory.id, { onDelete: 'cascade' }),
    parentSkuId: integer()
      .notNull()
      .references(() => parentSkus.id, { onDelete: 'cascade' }),
    isPrimary: boolean().default(false).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.inventoryId, t.parentSkuId] }),
    index('inventory_sku_parents_parent_idx').on(t.parentSkuId),
    uniqueIndex('inventory_sku_parents_primary_uq')
      .on(t.inventoryId)
      .where(sql`${t.isPrimary} = true`),
  ]
);

export type InventorySkuParent = typeof inventorySkuParents.$inferSelect;
export type NewInventorySkuParent = typeof inventorySkuParents.$inferInsert;
