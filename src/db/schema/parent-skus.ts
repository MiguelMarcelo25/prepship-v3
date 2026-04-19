import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { clients } from './clients';

export const parentSkus = pgTable(
  'parent_skus',
  {
    id: serial().primaryKey(),
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    sku: text(),
    baseUnitQty: integer().default(1).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('parent_skus_client_idx').on(t.clientId)]
);

export type ParentSku = typeof parentSkus.$inferSelect;
export type NewParentSku = typeof parentSkus.$inferInsert;
