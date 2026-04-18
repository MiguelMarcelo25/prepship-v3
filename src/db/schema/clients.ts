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
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
