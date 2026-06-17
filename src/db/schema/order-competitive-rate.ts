import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { orders } from './orders.js';
import { shipments } from './shipments.js';

// PS-220 — SHIPP house-account margin sidecar. LOCKDOWN-SAFE: a NEW table, never a column on the
// locked shipments table. drp_cost/margin are INTERNAL (portal-redacted); customer_rate is the
// billed + portal value. FK references to orders/shipments are reads (lockdown-permitted). The
// CHECK (margin >= 0) and the partial-unique indexes live in the migration + runtime ensure
// (drizzle/0049_order_competitive_rate.sql / ensure-order-competitive-rate.ts) — this schema is
// for typed access only and is intentionally NOT registered in drizzle.config.ts.
export const orderCompetitiveRate = pgTable('order_competitive_rate', {
  id: serial().primaryKey(),
  orderId: integer().notNull().references(() => orders.id, { onDelete: 'cascade' }),
  shipmentId: integer().references(() => shipments.id),
  clientId: integer().references(() => clients.id),
  drpCost: numeric({ precision: 10, scale: 2 }).notNull(),
  customerRate: numeric({ precision: 10, scale: 2 }).notNull(),
  margin: numeric({ precision: 10, scale: 2 }).notNull(),
  source: text(),
  sourceCarrier: text(),
  sourceService: text(),
  sourceProviderAccountId: integer(),
  competitorCount: integer().default(0).notNull(),
  isHouseOrder: boolean().default(false).notNull(),
  quoteFingerprint: text(),
  capturedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('order_competitive_rate_order_idx').on(t.orderId),
  index('order_competitive_rate_house_idx').on(t.isHouseOrder),
]);

export type OrderCompetitiveRate = typeof orderCompetitiveRate.$inferSelect;
export type NewOrderCompetitiveRate = typeof orderCompetitiveRate.$inferInsert;
