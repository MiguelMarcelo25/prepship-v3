import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { orders } from './orders';

/**
 * shipment_tracking_status — carrier tracking state per (order, tracking number).
 *
 * Per user override unlock shipped data on 2026-06-11: the shipments table is under
 * the shipped-data lockdown, so tracking state lives in THIS additive side table.
 * Rows are written ONLY by the shipment-tracking poller (src/services/
 * shipment-tracking.ts); shipments/orders are never mutated. Stored fields are
 * redacted by design: normalized status + a truncated carrier status line + dates —
 * never the carrier's events[] (city/state checkpoints) or raw payloads.
 */
export const shipmentTrackingStatus = pgTable(
  'shipment_tracking_status',
  {
    id: serial().primaryKey(),
    orderId: integer()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    clientId: integer(),
    trackingNumber: text().notNull(),
    carrierCode: text(),
    // NormalizedTrackingStatus['status']: unknown | pre_transit | in_transit |
    // delivered | exception | return_to_sender
    status: text().default('unknown').notNull(),
    statusDescription: text(),
    deliveredAt: timestamp({ withTimezone: true }),
    lastCheckedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    checkCount: integer().default(0).notNull(),
    lastError: text(),
    source: text().default('shipstation_v2').notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('shipment_tracking_status_order_tracking_unq').on(t.orderId, t.trackingNumber),
    index('shipment_tracking_status_order_idx').on(t.orderId),
    index('shipment_tracking_status_poll_idx').on(t.status, t.lastCheckedAt),
  ]
);

export type ShipmentTrackingStatusRow = typeof shipmentTrackingStatus.$inferSelect;
export type NewShipmentTrackingStatusRow = typeof shipmentTrackingStatus.$inferInsert;
