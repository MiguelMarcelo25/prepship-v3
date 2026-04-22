import { boolean, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const clients = pgTable('clients', {
  id: serial().primaryKey(),
  name: text().notNull(),
  storeIds: integer().array().default([]).notNull(),
  contactName: text(),
  email: text(),
  phone: text(),
  ssApiKey: text(),
  ssApiSecret: text(),
  ssApiKeyV2: text('ss_api_key_v2'),
  rateSourceClientId: integer(),
  brandName: text(),
  brandColor: text(),
  brandLogo: text(),
  active: boolean().default(true).notNull(),
  // When true this client is a sandbox — orders under it never sync from
  // ShipStation, never create real postage, never affect billing or
  // inventory, and are auto-excluded from daily stats. Toggled via the
  // one-time purge migration for anything whose name contains "test".
  isTest: boolean('is_test').default(false).notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
