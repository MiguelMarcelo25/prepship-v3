import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clients } from './clients';

export const orders = pgTable(
  'orders',
  {
    id: serial().primaryKey(),
    externalOrderId: text().unique(),
    clientId: integer().references(() => clients.id),
    orderNumber: text().notNull(),
    orderStatus: text().notNull().default('awaiting_shipment'),
    orderDate: timestamp({ withTimezone: true }),
    storeId: integer(),
    customerEmail: text(),
    shipToName: text(),
    shipToCity: text(),
    shipToState: text(),
    shipToPostalCode: text(),
    carrierCode: text(),
    serviceCode: text(),
    weightOz: real(),
    orderTotal: numeric({ precision: 10, scale: 2 }).default('0').notNull(),
    shippingAmount: numeric({ precision: 10, scale: 2 }).default('0').notNull(),
    items: jsonb().$type<unknown[]>().default([]).notNull(),
    raw: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    externallyShipped: boolean().default(false).notNull(),
    externallyFulfilledVerified: boolean().default(false).notNull(),
    // Order assignment: admin selects an order and "assigns" it to one of the
    // worker users. Workers see only orders assigned to them; admins see all.
    // user_id is the Supabase auth user UUID; email is mirrored for display
    // and audit so the row is still informative if the user is later deleted.
    assignedToUserId: text(),
    assignedToEmail: text(),
    assignedAt: timestamp({ withTimezone: true }),
    // Selling-platform fees (2026-05-13). Populated by the per-marketplace
    // fees fetcher (api/carriers/walmart/fees.ts for Walmart; eBay /
    // sell.finances comes later). Total = sum of commission + shipping
    // commission + processing + any other deductions returned by the
    // settlement endpoint. Breakdown stores the per-fee-type detail so a
    // future tooltip / billing-export can show "Commission $X.XX,
    // Processing $Y.YY" without re-fetching.
    sellingFee: numeric({ precision: 10, scale: 2 }).default('0').notNull(),
    sellingFeeBreakdown: jsonb().$type<Record<string, number>>().default({}).notNull(),
    sellingFeeSyncedAt: timestamp({ withTimezone: true }),
    // Provenance: which marketplace API populated this row's fees so we
    // can re-sync correctly + reason about stale data per source.
    sellingFeeSource: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('orders_status_idx').on(t.orderStatus),
    index('orders_client_idx').on(t.clientId),
    index('orders_store_idx').on(t.storeId),
    index('orders_date_idx').on(t.orderDate),
    index('orders_assigned_user_idx').on(t.assignedToUserId),
    index('orders_status_date_id_idx').on(t.orderStatus, t.orderDate.desc(), t.id.desc()),
    index('orders_store_status_date_idx')
      .on(t.storeId, t.orderStatus, t.orderDate.desc())
      .where(sql`${t.storeId} is not null`),
    index('orders_dashboard_sales_date_idx')
      .on(t.orderDate.desc())
      .where(sql`${t.orderStatus} <> 'cancelled'`),
    index('orders_dashboard_sales_client_date_idx')
      .on(t.clientId, t.orderDate.desc())
      .where(sql`${t.orderStatus} <> 'cancelled'`),
  ]
);

export const orderOverrides = pgTable('order_overrides', {
  orderId: integer()
    .primaryKey()
    .references(() => orders.id, { onDelete: 'cascade' }),
  residential: boolean(),
  trackingNumber: text(),
  notes: text().default(''),
  tags: jsonb().$type<string[]>().default([]).notNull(),
  refUspsRate: text(),
  refUpsRate: text(),
  rateWeightOz: real(),
  rateDimsL: real(),
  rateDimsW: real(),
  rateDimsH: real(),
  selectedPid: integer(),
  selectedPackageId: text(),
  bestRateJson: jsonb(),
  bestRateAt: timestamp({ withTimezone: true }),
  bestRateDims: text(),
  shippingAccount: text(),
  externallyShippedSource: text(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderOverrides = typeof orderOverrides.$inferSelect;
export type NewOrderOverrides = typeof orderOverrides.$inferInsert;
