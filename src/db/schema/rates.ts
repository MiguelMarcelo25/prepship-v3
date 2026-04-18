import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const rateCache = pgTable(
  'rate_cache',
  {
    cacheKey: text().primaryKey(),
    weightOz: real(),
    toZip: text(),
    rates: jsonb().$type<unknown[]>().notNull(),
    bestRate: jsonb(),
    weightVersion: integer(),
    fetchedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('rate_cache_weight_zip_idx').on(t.weightOz, t.toZip)]
);

export type RateCache = typeof rateCache.$inferSelect;
export type NewRateCache = typeof rateCache.$inferInsert;
