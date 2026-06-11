import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { orders } from './orders.js';

/**
 * PS-120 — per-order backend rate-job status.
 *
 * A tiny side table recording the in-progress state of the backend rate-backfill for one
 * awaiting order: `pending` (queued for the backfill job) or `rating` (the job is actively
 * rating it now). It is NOT money/proof data — the saved best rate lives on
 * order_overrides.best_rate_json. The row is keyed by orderId + the request fingerprint it
 * pins, so a dims/weight/zip change invalidates it and the orders payload falls back to its
 * existing terminal state (byte-identical to before this table existed).
 */
export const orderRateJobs = pgTable(
  'order_rate_jobs',
  {
    orderId: integer()
      .primaryKey()
      .references(() => orders.id, { onDelete: 'cascade' }),
    state: text().notNull(),
    requestFingerprint: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('order_rate_jobs_updated_idx').on(t.updatedAt.desc())],
);

export type OrderRateJob = typeof orderRateJobs.$inferSelect;
export type NewOrderRateJob = typeof orderRateJobs.$inferInsert;
