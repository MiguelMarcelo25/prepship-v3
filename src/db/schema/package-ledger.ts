import {
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { packages } from './packages.js';

export const packageLedger = pgTable(
  'package_ledger',
  {
    id: serial().primaryKey(),
    packageId: integer()
      .notNull()
      .references(() => packages.id, { onDelete: 'restrict' }),
    changeType: text().notNull(),
    qtyDelta: integer().notNull(),
    balanceAfter: integer().notNull(),
    note: text(),
    unitCost: numeric({ precision: 10, scale: 3 }),
    userId: uuid(),
    // Per user override unlock shipped data on 2026-07-11: PS-413 adds
    // structured outbound identity without rewriting legacy ledger rows.
    shipmentId: integer(),
    orderId: integer(),
    source: text(),
    sourceAccountId: text(),
    providerShipmentId: text(),
    effectiveAt: timestamp({ withTimezone: true }),
    idempotencyKey: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('package_ledger_package_idx').on(t.packageId),
    index('package_ledger_shipment_idx').on(t.shipmentId),
    index('package_ledger_order_idx').on(t.orderId),
    index('package_ledger_effective_at_idx').on(t.effectiveAt),
    uniqueIndex('package_ledger_idempotency_key_unq')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ]
);

export type PackageLedger = typeof packageLedger.$inferSelect;
export type NewPackageLedger = typeof packageLedger.$inferInsert;
