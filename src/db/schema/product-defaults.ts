import {
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// v2-parity: per-SKU default shipping hints (weight/dims/package). v4 inlines
// these on the products table, which is strictly a superset of v2's product
// table — this separate table mirrors v2's shape so integrations expecting
// it can read. The POST /products/save-defaults handler dual-writes into
// both products (canonical) and product_defaults (v2-parity view).
export const productDefaults = pgTable('product_defaults', {
  sku: text().primaryKey(),
  weightOz: numeric({ precision: 10, scale: 3 }),
  length: numeric({ precision: 10, scale: 3 }),
  width: numeric({ precision: 10, scale: 3 }),
  height: numeric({ precision: 10, scale: 3 }),
  defaultPackageCode: text(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type ProductDefaults = typeof productDefaults.$inferSelect;
export type NewProductDefaults = typeof productDefaults.$inferInsert;
