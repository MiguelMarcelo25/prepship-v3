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
import { clients } from './clients.js';
import { orders } from './orders.js';
import { shipments } from './shipments.js';
import { packages } from './packages.js';

// PS-312 (S0) — additive sidecar tables for backend-owned COMBINED SHIPMENT BUNDLES: multiple
// orders that intentionally ship together in ONE physical package (shared label/tracking/rate/
// package). This is the canonical SOURCE OF TRUTH the card requires — Orders/Billing/inventory/
// marketplace become thin consumers of it; the frontend must never infer bundle membership by
// matching names in React.
//
// Like PS-289's shipment_groups, these are PURELY ADDITIVE: they do NOT alter the locked
// shipments/orders tables (member rows only REFERENCE orders/shipments read-only), and the
// existing one-order↔one-shipment path is completely untouched.
export const shipmentBundles = pgTable(
  'shipment_bundles',
  {
    id: serial().primaryKey(),
    clientId: integer().references(() => clients.id),
    // The primary order/shipment owns the shared physical-shipment facts.
    primaryOrderId: integer().notNull().references(() => orders.id),
    primaryShipmentId: integer().references(() => shipments.id),
    // Shared shipment facts (frozen snapshot of the one label bought for the bundle).
    trackingNumber: text(),
    carrierCode: text(),
    serviceCode: text(),
    selectedRate: jsonb(),
    labelUrl: text(),
    labelShipmentId: text(),
    packageId: integer().references(() => packages.id),
    // draft → labeled → shipped → (voided | cancelled). Drives the Option-B display state.
    status: text().default('draft').notNull(),
    createdBy: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('shipment_bundles_client_idx').on(t.clientId),
    index('shipment_bundles_primary_order_idx').on(t.primaryOrderId),
  ],
);

export const shipmentBundleMembers = pgTable(
  'shipment_bundle_members',
  {
    id: serial().primaryKey(),
    bundleId: integer().notNull().references(() => shipmentBundles.id, { onDelete: 'cascade' }),
    orderId: integer().notNull().references(() => orders.id),
    role: text().notNull(), //  'primary' | 'child'
    status: text().default('active').notNull(), // 'active' | 'removed'
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // An order belongs to AT MOST ONE bundle — the structural guarantee that a child can never be
    // double-bundled (and the hook the read model uses to resolve a child to its primary).
    uniqueIndex('shipment_bundle_members_order_unq').on(t.orderId),
    index('shipment_bundle_members_bundle_idx').on(t.bundleId),
  ],
);

export type ShipmentBundle = typeof shipmentBundles.$inferSelect;
export type NewShipmentBundle = typeof shipmentBundles.$inferInsert;
export type ShipmentBundleMember = typeof shipmentBundleMembers.$inferSelect;
export type NewShipmentBundleMember = typeof shipmentBundleMembers.$inferInsert;
