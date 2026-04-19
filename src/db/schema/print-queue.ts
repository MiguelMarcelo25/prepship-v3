import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const printQueue = pgTable(
  'print_queue_orders',
  {
    id: text().primaryKey(),
    clientId: integer().notNull(),
    orderId: text().notNull(),
    orderNumber: text(),
    labelUrl: text().notNull(),
    skuGroupId: text().notNull(),
    primarySku: text(),
    itemDescription: text(),
    orderQty: integer().default(1).notNull(),
    multiSkuData: jsonb().$type<{ sku: string; qty: number }[]>(),
    status: text().default('queued').notNull(),
    printCount: integer().default(0).notNull(),
    lastPrintedAt: timestamp({ withTimezone: true }),
    queuedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('print_queue_order_client_unq').on(t.orderId, t.clientId),
    index('print_queue_client_status_idx').on(t.clientId, t.status),
  ]
);

export type PrintQueueEntry = typeof printQueue.$inferSelect;
export type NewPrintQueueEntry = typeof printQueue.$inferInsert;
