import { pgTable, text } from 'drizzle-orm/pg-core';

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: text(),
});

export type Setting = typeof settings.$inferSelect;
