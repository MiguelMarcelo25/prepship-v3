import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { shipments } from './shipments.js';

// v2-parity: return labels as a first-class row. v4 also stores
// isReturn/returnForShipmentId/returnReason directly on `shipments` — this
// table mirrors v2's denormalized history so integrations expecting the v2
// shape can read it.
export const returnLabels = pgTable(
  'return_labels',
  {
    id: serial().primaryKey(),
    shipmentId: integer()
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    returnShipmentId: integer().references(() => shipments.id, {
      onDelete: 'set null',
    }),
    returnTrackingNumber: text(),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('return_labels_shipment_idx').on(t.shipmentId),
    index('return_labels_return_idx').on(t.returnShipmentId),
  ]
);

export type ReturnLabel = typeof returnLabels.$inferSelect;
export type NewReturnLabel = typeof returnLabels.$inferInsert;
