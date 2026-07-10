import {
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Per user override unlock shipped data on 2026-07-11: unresolved real
// outbound shipments create durable review work, never guessed deductions.

export const packageConsumptionReviews = pgTable(
  'package_consumption_reviews',
  {
    id: serial().primaryKey(),
    shipmentId: integer().notNull(),
    orderId: integer(),
    source: text().notNull(),
    sourceAccountId: text(),
    providerShipmentId: text(),
    effectiveAt: timestamp({ withTimezone: true }).notNull(),
    idempotencyKey: text().notNull(),
    reason: text().notNull(),
    selectedPackageRef: text(),
    dimsL: real(),
    dimsW: real(),
    dimsH: real(),
    status: text().default('pending').notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('package_consumption_reviews_idempotency_unq').on(t.idempotencyKey),
    index('package_consumption_reviews_status_idx').on(t.status, t.effectiveAt),
    index('package_consumption_reviews_shipment_idx').on(t.shipmentId),
  ],
);

export type PackageConsumptionReview = typeof packageConsumptionReviews.$inferSelect;
