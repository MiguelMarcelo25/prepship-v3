import {
  boolean,
  integer,
  numeric,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const packages = pgTable('packages', {
  id: serial().primaryKey(),
  name: text().notNull(),
  type: text().default('box').notNull(),
  length: real().default(0).notNull(),
  width: real().default(0).notNull(),
  height: real().default(0).notNull(),
  tareWeightOz: real().default(0).notNull(),
  source: text().default('custom').notNull(),
  carrierCode: text(),
  packageCode: text(),
  domestic: boolean(),
  international: boolean(),
  stockQty: integer().default(0).notNull(),
  reorderLevel: integer().default(10).notNull(),
  unitCost: numeric({ precision: 10, scale: 2 }),
  isDefault: boolean().default(false).notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type Package = typeof packages.$inferSelect;
export type NewPackage = typeof packages.$inferInsert;
