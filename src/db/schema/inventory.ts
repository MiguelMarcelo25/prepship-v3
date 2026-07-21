import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { orders } from './orders.js';

export const inventory = pgTable(
  'inventory',
  {
    id: serial().primaryKey(),
    clientId: integer().references(() => clients.id),
    sku: text().notNull(),
    name: text(),
    imageUrl: text(),
    reorderLevel: integer().default(0).notNull(),
    weightOz: real().default(0),
    length: real(),
    width: real(),
    height: real(),
    parentSkuId: integer(),
    // v2-parity pack-size + billing fields.
    // baseUnitQty: how many base units per master pack (e.g. 12 bottles/case).
    // unitsPerPack: how many packs per shipping carton (nested multi-pack).
    // cuFtOverride: manual cubic-feet override for billing calcs when the
    //   default computed from L*W*H doesn't match reality.
    // packageId: default package to use when creating a label for this SKU.
    baseUnitQty: integer('base_unit_qty').default(1).notNull(),
    unitsPerPack: integer('units_per_pack').default(1).notNull(),
    cuFtOverride: real('cu_ft_override'),
    packageId: integer('package_id'),
    active: boolean().default(true).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('inventory_client_idx').on(t.clientId),
    index('inventory_sku_idx').on(t.sku),
    index('inventory_active_updated_idx').on(t.active, t.updatedAt),
    index('inventory_client_active_updated_idx').on(t.clientId, t.active, t.updatedAt),
    unique('inventory_client_sku_unq').on(t.clientId, t.sku),
  ]
);

export const inventoryLedger = pgTable(
  'inventory_ledger',
  {
    id: serial().primaryKey(),
    inventoryId: integer()
      .notNull()
      .references(() => inventory.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    qty: integer().notNull(),
    orderId: integer().references(() => orders.id),
    clientId: integer('client_id').references(() => clients.id),
    // Legacy movements may predate PS-439 identity fields. The insert guard
    // requires these fields for every new movement without rewriting history.
    sku: text(),
    sourceEntity: text('source_entity'),
    sourceId: text('source_id'),
    note: text(),
    createdBy: text(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('inventory_ledger_inv_idx').on(t.inventoryId),
    index('inventory_ledger_inv_type_idx').on(t.inventoryId, t.type),
    index('inventory_ledger_effective_at_idx').on(t.effectiveAt),
    uniqueIndex('inventory_ledger_idempotency_key_unq').on(t.idempotencyKey),
    uniqueIndex('inventory_ledger_source_identity_unq').on(
      t.sourceEntity,
      t.sourceId,
      t.inventoryId,
      t.type,
    ),
    index('inventory_ledger_created_idx').on(t.createdAt),
  ]
);

export type Inventory = typeof inventory.$inferSelect;
export type NewInventory = typeof inventory.$inferInsert;
export type InventoryLedger = typeof inventoryLedger.$inferSelect;
