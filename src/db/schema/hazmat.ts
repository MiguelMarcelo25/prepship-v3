import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { externalOperations } from './external-operations.js';
import { orders } from './orders.js';
import { shipments } from './shipments.js';

export const orderHazmatDeclarations = pgTable(
  'order_hazmat_declarations',
  {
    orderId: integer().primaryKey().references(() => orders.id, { onDelete: 'cascade' }),
    schemaVersion: smallint().default(1).notNull(),
    revision: integer().notNull(),
    status: text().$type<'clear' | 'active'>().notNull(),
    limitedQuantity: boolean(),
    containsBattery: boolean(),
    dryIce: boolean(),
    dryIceWeightValue: numeric({ precision: 12, scale: 4 }),
    dryIceWeightUnit: text(),
    emergencyContactName: text(),
    emergencyContactPhone: text(),
    uspsCategory: text(),
    uspsPackageLevel: boolean(),
    regulatedContentType: text(),
    semanticHash: text().notNull(),
    createdByUserId: text(),
    createdByEmail: text(),
    updatedByUserId: text(),
    updatedByEmail: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('order_hazmat_declarations_status_idx').on(t.status, t.updatedAt.desc()),
    check('order_hazmat_declarations_schema_version_chk', sql`${t.schemaVersion} > 0`),
    check('order_hazmat_declarations_revision_chk', sql`${t.revision} > 0`),
    check('order_hazmat_declarations_status_chk', sql`${t.status} in ('clear', 'active')`),
    check('order_hazmat_declarations_semantic_hash_chk', sql`${t.semanticHash} ~ '^hz_[a-f0-9]{64}$'`),
    check(
      'order_hazmat_declarations_dry_ice_weight_chk',
      sql`(${t.dryIce} is true and ${t.dryIceWeightValue} is not null and ${t.dryIceWeightValue} > 0 and ${t.dryIceWeightUnit} is not null) or (${t.dryIce} is distinct from true and ${t.dryIceWeightValue} is null and ${t.dryIceWeightUnit} is null)`,
    ),
  ],
);

export const orderHazmatMaterials = pgTable(
  'order_hazmat_materials',
  {
    id: serial().primaryKey(),
    orderId: integer().notNull().references(() => orderHazmatDeclarations.orderId, { onDelete: 'cascade' }),
    sequence: integer().notNull(),
    unNaNumber: text(),
    properShippingName: text(),
    technicalName: text(),
    hazardClass: text(),
    subsidiaryHazardClass: text(),
    packingGroup: text().$type<'i' | 'ii' | 'iii'>(),
    amount: numeric({ precision: 12, scale: 4 }),
    amountUnit: text(),
    quantity: integer(),
    packagingInstruction: text(),
    packagingInstructionSection: text(),
    packagingType: text(),
    transportMean: text(),
    transportCategory: text(),
    regulationAuthority: text(),
    regulationLevel: text(),
    radioactive: boolean(),
    reportableQuantity: boolean(),
    additionalDescription: text(),
  },
  (t) => [
    uniqueIndex('order_hazmat_materials_order_sequence_unq').on(t.orderId, t.sequence),
    index('order_hazmat_materials_order_idx').on(t.orderId),
    check('order_hazmat_materials_sequence_chk', sql`${t.sequence} > 0`),
    check('order_hazmat_materials_quantity_chk', sql`${t.quantity} is null or ${t.quantity} > 0`),
    check('order_hazmat_materials_amount_chk', sql`${t.amount} is null or ${t.amount} > 0`),
    check('order_hazmat_materials_packing_group_chk', sql`${t.packingGroup} is null or ${t.packingGroup} in ('i', 'ii', 'iii')`),
  ],
);

export const shipmentHazmatSnapshots = pgTable(
  'shipment_hazmat_snapshots',
  {
    shipmentId: integer().primaryKey().references(() => shipments.id, { onDelete: 'restrict' }),
    externalOperationId: integer().references(() => externalOperations.id, { onDelete: 'restrict' }),
    snapshotSchemaVersion: smallint().notNull(),
    orderDeclarationRevision: integer().notNull(),
    snapshotHash: text().notNull(),
    summaryIsHazmat: boolean().notNull(),
    summaryProfile: text().notNull(),
    snapshotJson: jsonb().$type<Record<string, unknown>>().notNull(),
    reviewedByUserId: text(),
    reviewedByEmail: text(),
    reviewedAt: timestamp({ withTimezone: true }),
    capturedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    captureKind: text().$type<'provider_purchase' | 'test_label'>().notNull(),
  },
  (t) => [
    index('shipment_hazmat_snapshots_operation_idx').on(t.externalOperationId),
    index('shipment_hazmat_snapshots_profile_idx').on(t.summaryProfile, t.capturedAt.desc()),
    check('shipment_hazmat_snapshots_schema_version_chk', sql`${t.snapshotSchemaVersion} > 0`),
    check('shipment_hazmat_snapshots_revision_chk', sql`${t.orderDeclarationRevision} > 0`),
    check('shipment_hazmat_snapshots_hash_chk', sql`${t.snapshotHash} ~ '^hz_[a-f0-9]{64}$'`),
    check('shipment_hazmat_snapshots_active_chk', sql`${t.summaryIsHazmat} is true`),
    check(
      'shipment_hazmat_snapshots_profile_chk',
      sql`${t.summaryProfile} in ('shipstation_usps', 'shipstation_ups_dry_ice', 'shipstation_ups_dangerous_goods', 'ups_direct', 'walmart')`,
    ),
    check('shipment_hazmat_snapshots_capture_kind_chk', sql`${t.captureKind} in ('provider_purchase', 'test_label')`),
  ],
);

export type OrderHazmatDeclarationRow = typeof orderHazmatDeclarations.$inferSelect;
export type NewOrderHazmatDeclarationRow = typeof orderHazmatDeclarations.$inferInsert;
export type OrderHazmatMaterialRow = typeof orderHazmatMaterials.$inferSelect;
export type NewOrderHazmatMaterialRow = typeof orderHazmatMaterials.$inferInsert;
export type ShipmentHazmatSnapshotRow = typeof shipmentHazmatSnapshots.$inferSelect;
export type NewShipmentHazmatSnapshotRow = typeof shipmentHazmatSnapshots.$inferInsert;
