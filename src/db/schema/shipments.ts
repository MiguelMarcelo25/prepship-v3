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
import { clients } from './clients.js';
import { orders } from './orders.js';

// Source-of-truth note: shipments owns durable label/shipment records.
// Selected rate, provider, account, tracking, and cost fields are frozen
// operational snapshots for the action that created the label.
export const shipments = pgTable(
  'shipments',
  {
    id: serial().primaryKey(),
    orderId: integer().references(() => orders.id),
    clientId: integer().references(() => clients.id),
    orderNumber: text(),
    carrierCode: text(),
    serviceCode: text(),
    trackingNumber: text(),
    shipDate: timestamp({ withTimezone: true }),
    createDate: timestamp({ withTimezone: true }),
    weightOz: real(),
    dimsL: real(),
    dimsW: real(),
    dimsH: real(),
    cost: numeric({ precision: 10, scale: 2 }),
    otherCost: numeric({ precision: 10, scale: 2 }).default('0').notNull(),
    // PS-370: the normalized selected/label total (postage + other), persisted so
    // TS and SQL read ONE value instead of each re-deriving "what did the label
    // cost". Nullable — NULL means un-backfilled; every reader falls back to its
    // existing derivation, so this is byte-neutral until the Phase-2 backfill.
    // Additive column on a lockdown table (read/type addition, not a drop/type
    // change) — no shipped-row mutation in Phase 1.
    selectedRateCost: numeric({ precision: 10, scale: 2 }),
    labelUrl: text(),
    labelCreatedAt: timestamp({ withTimezone: true }),
    labelFormat: text(),
    labelCarrier: text(),
    labelService: text(),
    labelTracking: text(),
    labelCost: numeric({ precision: 10, scale: 2 }),
    labelShipDate: timestamp({ withTimezone: true }),
    labelProvider: integer(),
    labelShipmentId: integer(),
    selectedRateJson: jsonb(),
    selectedPid: integer(),
    selectedPackageId: text(),
    providerAccountId: integer(),
    providerAccountNickname: text(),
    carrierProvider: text(),
    carrierAccountId: text(),
    labelProviderKey: text(),
    confirmationProvider: text(),
    confirmationStatus: text(),
    confirmationAttempts: integer().default(0).notNull(),
    confirmationLastError: text(),
    marketplaceConfirmedAt: timestamp({ withTimezone: true }),
    voided: boolean().default(false).notNull(),
    source: text(),
    isReturn: boolean().default(false).notNull(),
    returnForShipmentId: integer(),
    returnReason: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('shipments_order_idx').on(t.orderId),
    index('shipments_client_idx').on(t.clientId),
    index('shipments_date_idx').on(t.shipDate),
    index('shipments_order_latest_idx')
      .on(t.orderId, t.id.desc())
      .where(sql`${t.orderId} is not null and coalesce(${t.voided}, false) = false`),
    index('shipments_order_number_latest_idx')
      .on(t.orderNumber, t.id.desc())
      .where(sql`${t.orderNumber} is not null and ${t.orderId} is null and coalesce(${t.voided}, false) = false`),
    index('shipments_confirmation_status_idx').on(t.confirmationStatus),
    index('shipments_carrier_provider_idx').on(t.carrierProvider),
    // Per user override unlock shipped data on 2026-07-13 (AUDIT-2026-07-13.md
    // M2/SY-3): ADDITIVE index definitions only — created on prod the same day
    // (migration audit_2026_07_13_week1_indexes_and_rls). tracking_number had no
    // btree (only a trigram search index), so the sync provider-account enrichment
    // seq-scanned shipments 2.35M times; label_shipment_id is the sync page's
    // existing-row match key. A UNIQUE variant of the label index is blocked on
    // one pre-existing duplicate pair (label_shipment_id 155168257) pending an
    // operator decision.
    index('shipments_tracking_number_idx')
      .on(t.trackingNumber)
      .where(sql`${t.trackingNumber} is not null`),
    index('shipments_label_shipment_id_idx')
      .on(t.labelShipmentId)
      .where(sql`${t.labelShipmentId} is not null`),
  ]
);

export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;
