import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { clients } from './clients';
import { orders } from './orders';
import { shipments } from './shipments';

export const billingConfig = pgTable('billing_config', {
  clientId: integer()
    .primaryKey()
    .references(() => clients.id, { onDelete: 'cascade' }),
  pickPackFee: numeric({ precision: 10, scale: 2 }).default('0').notNull(),
  additionalUnitFee: numeric({ precision: 10, scale: 2 }).default('0').notNull(),
  packageCostMarkup: numeric({ precision: 5, scale: 2 }).default('0').notNull(),
  shippingMarkupPct: numeric({ precision: 5, scale: 2 }).default('0').notNull(),
  shippingMarkupFlat: numeric({ precision: 10, scale: 2 }).default('0').notNull(),
  billingMode: text().default('per_shipment').notNull(),
  active: boolean().default(true).notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const billingLineItems = pgTable(
  'billing_line_items',
  {
    id: serial().primaryKey(),
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    orderId: integer().references(() => orders.id),
    orderNumber: text(),
    shipmentId: integer().references(() => shipments.id),
    shipDate: timestamp({ withTimezone: true }),
    lineType: text().notNull(),
    description: text().notNull(),
    qty: numeric({ precision: 10, scale: 2 }).default('1').notNull(),
    unitCost: numeric({ precision: 10, scale: 2 }).notNull(),
    totalCost: numeric({ precision: 10, scale: 2 }).notNull(),
    invoiced: boolean().default(false).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('billing_li_client_idx').on(t.clientId),
    index('billing_li_date_idx').on(t.shipDate),
    unique('billing_li_unique').on(t.orderId, t.lineType, t.description),
  ]
);

export type BillingConfig = typeof billingConfig.$inferSelect;
export type NewBillingConfig = typeof billingConfig.$inferInsert;
export type BillingLineItem = typeof billingLineItems.$inferSelect;

export const clientPackagePrices = pgTable(
  'client_package_prices',
  {
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    packageId: integer().notNull(),
    price: numeric({ precision: 10, scale: 2 }).notNull(),
    isCustom: boolean().default(false).notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('client_package_prices_pk_idx').on(t.clientId, t.packageId),
  ]
);

export const billingRefRates = pgTable(
  'billing_ref_rates',
  {
    id: serial().primaryKey(),
    weightOz: integer(),
    zipTo: text(),
    carrier: text(),
    service: text(),
    cost: numeric({ precision: 10, scale: 2 }),
    source: text(),
    fetchedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('billing_ref_rates_lookup_idx').on(t.weightOz, t.zipTo, t.carrier),
  ]
);

export type ClientPackagePrice = typeof clientPackagePrices.$inferSelect;
export type BillingRefRate = typeof billingRefRates.$inferSelect;
