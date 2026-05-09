import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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

// Many-to-many junction: a carrier account can be assigned to
// multiple clients (operators reuse the same UPS/USPS/FedEx
// credentials across several DR Prepper sub-stores). The legacy
// carrierAccounts.clientId stays as a backward-compat anchor;
// this junction is the authoritative source going forward.
export const carrierAccountClients = pgTable(
  'carrier_account_clients',
  {
    carrierAccountId: integer('carrier_account_id')
      .notNull()
      .references(() => carrierAccounts.id, { onDelete: 'cascade' }),
    clientId: integer('client_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.carrierAccountId, t.clientId] }),
    index('carrier_account_clients_client_idx').on(t.clientId),
  ],
);

export type CarrierAccount = typeof carrierAccounts.$inferSelect;
export type NewCarrierAccount = typeof carrierAccounts.$inferInsert;
export type CarrierAccountClient = typeof carrierAccountClients.$inferSelect;
export type NewCarrierAccountClient = typeof carrierAccountClients.$inferInsert;
