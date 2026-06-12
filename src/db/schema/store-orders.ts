import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * PS-200 S6 — store_orders adopted into the v4 Drizzle schema (READ/TYPE
 * addition ONLY). The table is owned by drizzle/0030_store_orders.sql and is
 * the PS-199 Walmart purchase-order resolver's CACHE — its DATA must never be
 * dropped or rewritten by schema work, and this definition exists so ONE
 * schema owner describes the table (it previously lived only in the legacy
 * api/_lib readiness checker). Runtime readiness verification stays in
 * src/services/store-orders-schema.ts (no DDL at request time).
 *
 * Column shapes mirror the migration exactly; do not "improve" them here —
 * the migration is the source of truth.
 */
export const storeOrders = pgTable(
  'store_orders',
  {
    id: serial().primaryKey(),
    carrierAccountId: integer().notNull(),
    provider: text().notNull(),
    externalOrderId: text().notNull(),
    customerOrderId: text(),
    orderDate: timestamp({ withTimezone: true, mode: 'date' }),
    sourceStatus: text(),
    shipTo: jsonb(),
    items: jsonb(),
    totals: jsonb(),
    raw: jsonb().notNull().default({}),
    shipmentStatus: text().notNull().default('unshipped'),
    trackingNumber: text(),
    trackingCarrier: text(),
    shippedAt: timestamp({ withTimezone: true, mode: 'date' }),
    firstFetchedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastFetchedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('store_orders_provider_external_idx').on(table.provider, table.externalOrderId),
    index('store_orders_carrier_account_idx').on(table.carrierAccountId),
    index('store_orders_last_fetched_at_idx').on(table.lastFetchedAt.desc()),
    index('store_orders_shipment_status_idx').on(table.shipmentStatus),
  ],
);

export type StoreOrder = typeof storeOrders.$inferSelect;
