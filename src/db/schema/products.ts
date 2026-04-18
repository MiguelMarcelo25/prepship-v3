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
