import {
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { packages } from './packages';

export const packageLedger = pgTable(
  'package_ledger',
  {
    id: serial().primaryKey(),
    packageId: integer()
      .notNull()
      .references(() => packages.id, { onDelete: 'cascade' }),
    changeType: text().notNull(),
    qtyDelta: integer().notNull(),
    balanceAfter: integer().notNull(),
    note: text(),
    unitCost: numeric({ precision: 10, scale: 3 }),
    userId: uuid(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('package_ledger_package_idx').on(t.packageId)]
);

export type PackageLedger = typeof packageLedger.$inferSelect;
export type NewPackageLedger = typeof packageLedger.$inferInsert;
