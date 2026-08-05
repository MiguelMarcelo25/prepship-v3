import {
  boolean,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { orders } from './orders.js';

// PS-487: READ-ONLY mapping of the shared `returns` table.
//
// The returns domain is owned by the Client Portal repo; PrepShip previously modelled
// only `return_labels`, which is why returns looked absent from this side. PrepShip
// needs to READ these rows to bill them — it does not own their lifecycle and must not
// write them here.
//
// Every column below was verified present in production on 2026-08-05 before being
// mapped. That matters: a Drizzle column that does not exist in the database makes even
// a bare select() emit it and 500 the route, so this mirrors the live table exactly and
// adds nothing speculative. Notably there is NO billing-date-override column yet — the
// planner treats a correction as optional and falls back to created_at until AC-4 adds
// storage for it.
export const returns = pgTable('returns', {
  id: serial().primaryKey(),
  orderId: integer('order_id')
    .notNull()
    .references(() => orders.id),
  clientId: integer('client_id'),
  returnShipmentId: integer('return_shipment_id'),
  returnToLocationId: integer('return_to_location_id'),
  status: text().notNull(),
  initiatedBy: text('initiated_by').notNull(),
  initiatedByEmail: text('initiated_by_email'),
  reason: text(),
  adminOverride: boolean('admin_override').notNull(),
  adminOverrideBy: text('admin_override_by'),
  adminOverrideReason: text('admin_override_reason'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  deliveryMethod: text('delivery_method'),
  deliveryStatus: text('delivery_status'),
  deliveryError: text('delivery_error'),
  returnReference: text('return_reference'),
  /** The configured CUSTOMER return-shipping charge — never a provider/internal cost. */
  returnCustomerShippingRate: numeric('return_customer_shipping_rate', {
    precision: 10,
    scale: 2,
  }),
  returnRecipientName: text('return_recipient_name'),
});

export type ReturnRow = typeof returns.$inferSelect;
