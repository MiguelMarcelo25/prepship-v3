import {
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// v2-parity: persistent mock label store. v4 previously kept these in a
// process-local Map, which meant dev/test labels didn't survive a server
// restart. Persisting them matches v2 behavior exactly and unblocks E2E
// flows that restart the API between label create and retrieve.
export const mockLabels = pgTable('mock_labels', {
  shipmentId: integer().primaryKey(),
  orderNumber: text(),
  trackingNumber: text().notNull(),
  serviceLabel: text(),
  weightOz: numeric({ precision: 10, scale: 2 }),
  shipFrom: text(),
  shipTo: text(),
  shipDate: text(),
  pdfBase64: text(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type MockLabel = typeof mockLabels.$inferSelect;
export type NewMockLabel = typeof mockLabels.$inferInsert;
