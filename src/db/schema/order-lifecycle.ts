import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { inventory } from './inventory.js';
import { orders } from './orders.js';
import { shipments } from './shipments.js';

export type FulfilledLineSnapshot = {
  lineKey: string;
  sku: string | null;
  name: string | null;
  quantity: number;
  reviewReason?: 'missing_quantity' | 'invalid_quantity';
};

/**
 * PS-424 source of truth: an immutable receipt for one normalized order
 * lifecycle command. Callers may translate provider payloads, but they may
 * not write terminal order state or fulfillment claims themselves.
 */
export const orderLifecycleEvents = pgTable(
  'order_lifecycle_events',
  {
    id: serial().primaryKey(),
    orderId: integer().notNull().references(() => orders.id),
    shipmentId: integer().references(() => shipments.id),
    commandKey: text().notNull(),
    transition: text().notNull(),
    source: text().notNull(),
    provenance: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    fulfilledLines: jsonb().$type<FulfilledLineSnapshot[]>().default([]).notNull(),
    effectiveAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('order_lifecycle_events_command_unq').on(t.commandKey),
    index('order_lifecycle_events_order_idx').on(t.orderId, t.id),
    index('order_lifecycle_events_shipment_idx').on(t.shipmentId),
  ],
);

/**
 * Exact inventory work created by a lifecycle event. A claim is never keyed
 * only by order: shipment + fulfillment line identity is retained so split
 * shipments and relabels have independent, reversible stock movements.
 */
export const fulfillmentLineClaims = pgTable(
  'fulfillment_line_claims',
  {
    id: serial().primaryKey(),
    lifecycleEventId: integer().notNull().references(() => orderLifecycleEvents.id),
    orderId: integer().notNull().references(() => orders.id),
    shipmentId: integer().references(() => shipments.id),
    lineKey: text().notNull(),
    sku: text(),
    name: text(),
    quantity: integer().notNull(),
    direction: text().notNull(),
    originalClaimId: integer().references((): AnyPgColumn => fulfillmentLineClaims.id),
    inventoryId: integer().references(() => inventory.id),
    status: text().notNull().default('pending'),
    idempotencyKey: text().notNull(),
    attempts: integer().notNull().default(0),
    lastError: text(),
    appliedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('fulfillment_line_claims_idempotency_unq').on(t.idempotencyKey),
    index('fulfillment_line_claims_event_status_idx').on(t.lifecycleEventId, t.status),
    index('fulfillment_line_claims_shipment_idx').on(t.shipmentId, t.id),
    index('fulfillment_line_claims_original_idx').on(t.originalClaimId),
  ],
);

export type OrderLifecycleEvent = typeof orderLifecycleEvents.$inferSelect;
export type FulfillmentLineClaim = typeof fulfillmentLineClaims.$inferSelect;
