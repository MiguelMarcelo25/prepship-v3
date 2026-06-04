import {
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clients } from './clients.js';
import { orders } from './orders.js';

// Source-of-truth note: order_items is the canonical table for SKU/item
// analytics. orders.items remains raw import compatibility.
export const orderItems = pgTable(
  'order_items',
  {
    id: serial().primaryKey(),
    orderId: integer()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    lineIndex: integer().notNull().default(0),
    sku: text().notNull(),
    name: text(),
    quantity: numeric({ precision: 12, scale: 3 }).default('0').notNull(),
    unitPrice: numeric({ precision: 12, scale: 2 }).default('0').notNull(),
    lineTotal: numeric({ precision: 12, scale: 2 }).default('0').notNull(),
    imageUrl: text(),
    clientId: integer().references(() => clients.id),
    storeId: integer(),
    orderStatus: text().notNull(),
    orderDate: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('order_items_order_line_idx').on(t.orderId, t.lineIndex),
    index('order_items_order_id_idx').on(t.orderId),
    index('order_items_sku_idx').on(t.sku),
    index('order_items_lower_sku_idx').on(sql`lower(${t.sku})`),
    index('order_items_date_idx').on(t.orderDate),
    index('order_items_client_date_idx').on(t.clientId, t.orderDate),
    index('order_items_store_date_idx').on(t.storeId, t.orderDate),
    index('order_items_active_date_idx')
      .on(t.orderDate)
      .where(sql`${t.orderStatus} <> 'cancelled'`),
    index('order_items_active_client_date_idx')
      .on(t.clientId, t.orderDate)
      .where(sql`${t.orderStatus} <> 'cancelled'`),
    index('order_items_active_sku_date_idx')
      .on(t.sku, t.orderDate)
      .where(sql`${t.orderStatus} <> 'cancelled'`),
  ]
);

export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
