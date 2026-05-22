import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Source-of-truth note: rate_cache is a performance cache only. Purchased
// label billing/audit should use the frozen selected rate on shipments.
export const rateCache = pgTable(
  'rate_cache',
  {
    cacheKey: text().primaryKey(),
    weightOz: real(),
    toZip: text(),
    rates: jsonb().$type<unknown[]>().notNull(),
    bestRate: jsonb(),
    diagnostics: jsonb().$type<unknown[]>(),
    weightVersion: integer(),
    fetchedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('rate_cache_weight_zip_idx').on(t.weightOz, t.toZip)]
);

export type RateCache = typeof rateCache.$inferSelect;
export type NewRateCache = typeof rateCache.$inferInsert;
