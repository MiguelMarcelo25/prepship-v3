import {
  integer,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const products = pgTable('products', {
  id: serial().primaryKey(),
  sku: text().unique(),
  name: text(),
  imageUrl: text(),
  weightOz: real().default(0).notNull(),
  length: real().default(0).notNull(),
  width: real().default(0).notNull(),
  height: real().default(0).notNull(),
  defaultPackageCode: text(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// PS-153 audit (2026-06-09): `sku_qty_dims` is CODE-DEAD — no Drizzle reference and no raw-SQL access
// anywhere in src/. RETAINED ON PURPOSE: the DB table exists and drizzle-kit generate diffs schema vs
// DB, so deleting this definition would arm the next migration to DROP the table (data loss). Do NOT
// remove without a deliberate, approval-gated DROP migration. Guard: scripts/ps-153-dead-symbols-guard.ts.
export const skuQtyDims = pgTable(
  'sku_qty_dims',
  {
    sku: text().notNull(),
    qty: integer().notNull(),
    length: real(),
    width: real(),
    height: real(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.sku, t.qty] })]
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
