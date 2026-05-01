import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const carrierAccounts = pgTable(
  'carrier_accounts',
  {
    id: serial().primaryKey(),
    clientId: integer(),
    provider: text().notNull(),
    label: text(),
    accountIdentifier: text(),
    credentials: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    source: text().default('admin').notNull(),
    active: boolean().default(true).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('carrier_accounts_client_provider_account_idx').on(
      sql`COALESCE(${t.clientId}, -1)`,
      t.provider,
      sql`COALESCE(${t.accountIdentifier}, '')`,
    ),
  ],
);

export type CarrierAccount = typeof carrierAccounts.$inferSelect;
export type NewCarrierAccount = typeof carrierAccounts.$inferInsert;
