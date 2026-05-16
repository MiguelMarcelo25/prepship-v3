import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const analyticsCache = pgTable(
  'analytics_cache',
  {
    cacheKey: text().primaryKey(),
    payload: jsonb().$type<unknown>().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('analytics_cache_expires_idx').on(t.expiresAt)]
);

export type AnalyticsCache = typeof analyticsCache.$inferSelect;
