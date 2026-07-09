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
import { sql } from 'drizzle-orm';
import { clients } from './clients.js';

export const storeSourceCutovers = pgTable(
  'store_source_cutovers',
  {
    id: serial().primaryKey(),
    clientId: integer().notNull().references(() => clients.id),
    legacyProvider: text().notNull().default('shipstation'),
    legacyStoreId: integer().notNull(),
    targetProvider: text().notNull().default('shopify'),
    targetStoreAccountId: integer().notNull(),
    mode: text().notNull().default('active'),
    syncAnchorAt: timestamp({ withTimezone: true }),
    dryRunSummary: jsonb().$type<Record<string, unknown> | null>(),
    createdBy: text(),
    updatedBy: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('store_source_cutovers_client_idx').on(t.clientId),
    index('store_source_cutovers_legacy_idx').on(t.legacyProvider, t.legacyStoreId),
    index('store_source_cutovers_target_idx').on(t.targetProvider, t.targetStoreAccountId),
    uniqueIndex('store_source_cutovers_identity_idx')
      .on(t.legacyProvider, t.legacyStoreId, t.targetProvider, t.targetStoreAccountId),
    uniqueIndex('store_source_cutovers_active_legacy_idx')
      .on(t.legacyProvider, t.legacyStoreId)
      .where(sql`${t.mode} = 'active'`),
  ],
);

export type StoreSourceCutover = typeof storeSourceCutovers.$inferSelect;
export type NewStoreSourceCutover = typeof storeSourceCutovers.$inferInsert;
