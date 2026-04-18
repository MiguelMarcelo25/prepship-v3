import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { clients } from './clients';
import { orders } from './orders';

export const inventory = pgTable(
  'inventory',
  {
    id: serial().primaryKey(),
    clientId: integer().references(() => clients.id),
    sku: text().notNull(),
    name: text(),
    imageUrl: text(),
    stockQty: integer().default(0).notNull(),
    reorderLevel: integer().default(0).notNull(),
    weightOz: real().default(0),
    length: real(),
    width: real(),
    height: real(),
    active: boolean().default(true).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('inventory_client_idx').on(t.clientId),
    index('inventory_sku_idx').on(t.sku),
    unique('inventory_client_sku_unq').on(t.clientId, t.sku),
  ]
);

export const inventoryLedger = pgTable(
  'inventory_ledger',
  {
    id: serial().primaryKey(),
    inventoryId: integer()
      .notNull()
      .references(() => inventory.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    qty: integer().notNull(),
    orderId: integer().references(() => orders.id),
    note: text(),
    createdBy: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('inventory_ledger_inv_idx').on(t.inventoryId),
    index('inventory_ledger_created_idx').on(t.createdAt),
  ]
);

export type Inventory = typeof inventory.$inferSelect;
export type NewInventory = typeof inventory.$inferInsert;
export type InventoryLedger = typeof inventoryLedger.$inferSelect;
