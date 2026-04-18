import {
  boolean,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const locations = pgTable('locations', {
  id: serial().primaryKey(),
  name: text().notNull(),
  company: text(),
  street1: text(),
  street2: text(),
  city: text(),
  state: text(),
  postalCode: text(),
  country: text().default('US').notNull(),
  phone: text(),
  isDefault: boolean().default(false).notNull(),
  active: boolean().default(true).notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
