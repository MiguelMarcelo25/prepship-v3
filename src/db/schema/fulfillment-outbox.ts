import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { orders } from './orders.js';
import { shipments } from './shipments.js';

export const fulfillmentOutbox = pgTable(
  'fulfillment_outbox',
  {
    id: serial().primaryKey(),
    orderId: integer().notNull().references(() => orders.id),
    shipmentId: integer().references(() => shipments.id),
    eventType: text().notNull(),
    provider: text().notNull(),
    dedupeKey: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    status: text().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    nextRunAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('fulfillment_outbox_dedupe_idx').on(t.dedupeKey),
    index('fulfillment_outbox_due_idx').on(t.status, t.nextRunAt),
  ],
);

export type FulfillmentOutbox = typeof fulfillmentOutbox.$inferSelect;
export type NewFulfillmentOutbox = typeof fulfillmentOutbox.$inferInsert;
