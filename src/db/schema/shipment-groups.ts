import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { orders } from './orders.js';
import { shipments } from './shipments.js';

export type ShipmentGroupPackageItem = {
  sku: string | null;
  itemId: string | number | null;
  quantity: number | null;
};

// PS-289 - additive sidecar tables for multi-package planning. These do not
// alter the locked shipments table; package rows may reference a shipment only
// after a future per-package label workflow creates one.
export const shipmentGroups = pgTable(
  'shipment_groups',
  {
    id: serial().primaryKey(),
    orderId: integer().notNull().references(() => orders.id, { onDelete: 'cascade' }),
    clientId: integer().references(() => clients.id),
    orderNumber: text(),
    groupKey: text().notNull(),
    status: text().default('planned').notNull(),
    packageCount: integer().default(0).notNull(),
    metadata: jsonb(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('shipment_groups_group_key_unq').on(t.groupKey),
    index('shipment_groups_order_idx').on(t.orderId),
    index('shipment_groups_client_status_idx').on(t.clientId, t.status),
  ],
);

export const shipmentGroupPackages = pgTable(
  'shipment_group_packages',
  {
    id: serial().primaryKey(),
    shipmentGroupId: integer()
      .notNull()
      .references(() => shipmentGroups.id, { onDelete: 'cascade' }),
    orderId: integer().notNull().references(() => orders.id, { onDelete: 'cascade' }),
    clientId: integer().references(() => clients.id),
    packageKey: text().notNull(),
    packageSequence: integer().notNull(),
    labelIdempotencyKey: text().notNull(),
    weightOz: real(),
    dimsL: real(),
    dimsW: real(),
    dimsH: real(),
    items: jsonb().$type<ShipmentGroupPackageItem[]>(),
    status: text().default('planned').notNull(),
    shipmentId: integer().references(() => shipments.id),
    trackingNumber: text(),
    labelUrl: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('shipment_group_packages_key_unq').on(t.shipmentGroupId, t.packageKey),
    uniqueIndex('shipment_group_packages_sequence_unq').on(t.shipmentGroupId, t.packageSequence),
    uniqueIndex('shipment_group_packages_label_idempotency_unq').on(t.labelIdempotencyKey),
    index('shipment_group_packages_order_idx').on(t.orderId),
    index('shipment_group_packages_shipment_idx').on(t.shipmentId),
  ],
);

export type ShipmentGroup = typeof shipmentGroups.$inferSelect;
export type NewShipmentGroup = typeof shipmentGroups.$inferInsert;
export type ShipmentGroupPackage = typeof shipmentGroupPackages.$inferSelect;
export type NewShipmentGroupPackage = typeof shipmentGroupPackages.$inferInsert;
