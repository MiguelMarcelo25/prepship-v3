import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { orders } from './orders.js';

// PS-497 / PS-489 Slice 1 — the canonical physical-fulfillment identity. Migration 0104 owns
// this table; runtime-schema-readiness enrollment and the projection-column mapping on
// order_lifecycle_events / fulfillment_line_claims join the tree as part of the production-apply
// step (the same PS-502 discipline recorded at runtime-schema-readiness.ts:19-22). Nothing
// selects from this relation until the Slice-2 resolver does, so this object is inert on its own.

/**
 * One physical fulfillment. Shipments and lifecycle events PROJECT this row; they do not own it.
 *
 * The row is resolved-or-created by a deterministic natural key (`occurrenceKey`) so retries and
 * concurrent writers converge on a single winner via `INSERT ... ON CONFLICT (occurrence_key)
 * DO NOTHING` then a `SELECT`. Split shipments produce distinct keys and therefore distinct
 * occurrences; a whole-order external fulfillment produces exactly one.
 */
export const fulfillmentOccurrences = pgTable(
  'fulfillment_occurrences',
  {
    id: serial().primaryKey(),
    orderId: integer().notNull().references(() => orders.id),
    // Option B (soft reference): NO `.references(() => shipments.id)`. The occurrence -> shipment
    // link lives here, made 1:1 by `fulfillment_occurrences_shipment_unq`, but carries no foreign
    // key so this slice never touches the shipped/cancelled lockdown surface.
    shipmentId: integer(),
    occurrenceKey: text().notNull(),
    discriminatorKind: text().notNull(),
    firstSeenSource: text().notNull(),
    supersededByOccurrenceId: integer().references((): AnyPgColumn => fulfillmentOccurrences.id),
    effectiveAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('fulfillment_occurrences_key_unq').on(t.occurrenceKey),
    index('fulfillment_occurrences_order_idx').on(t.orderId, t.id),
    // matches migration 0104's partial predicate: one occurrence per local shipment
    // (shipment-less occurrences are unconstrained)
    uniqueIndex('fulfillment_occurrences_shipment_unq')
      .on(t.shipmentId)
      .where(sql`${t.shipmentId} is not null`),
  ],
);

export type FulfillmentOccurrence = typeof fulfillmentOccurrences.$inferSelect;
export type NewFulfillmentOccurrence = typeof fulfillmentOccurrences.$inferInsert;

/** The three physical-fulfillment shapes an occurrence can take. */
export type FulfillmentOccurrenceKind = 'provider_shipment' | 'local_shipment' | 'whole_order';
