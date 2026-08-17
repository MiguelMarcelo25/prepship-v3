import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orders } from './orders.js';
import { clients } from './clients.js';
import { shipments } from './shipments.js';

// PS-502 — the replacement (outbound re-ship) tables.
//
// Mirrors migrations 0096/0097 EXACTLY. That precision is not pedantry: a Drizzle column
// that does not exist in the database makes even a bare select() emit it and 500 the route,
// which is the failure returns.ts documents from PS-487. Nothing speculative is declared
// here, and nothing in the migrations is omitted.
//
// CHECK constraints are MIGRATION-OWNED and deliberately absent below, following the
// billing_line_items precedent: Drizzle's table-level check support has changed shape across
// versions, and a constraint declared in two places is a constraint that can disagree with
// itself. `replacements_status_check` and `replacements_admin_override_attribution_check`
// live in 0096 and only there.

export const replacements = pgTable(
  'replacements',
  {
    id: serial().primaryKey(),

    // The INTERNAL primary key of the original order, never the visible number. RESTRICT
    // because a replacement is evidence that goods were re-sent against this order; letting
    // the order delete out from under it would erase the reason the re-ship happened.
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    clientId: integer('client_id').references(() => clients.id),

    // The replacement's own outbound shipment, once one exists. SET NULL rather than
    // RESTRICT so a shipment row can be removed without orphaning the replacement's history.
    replacementShipmentId: integer('replacement_shipment_id').references(() => shipments.id, {
      onDelete: 'set null',
    }),

    // Operator-visible identity: 1321-REPLACE, 1321-REPLACE-2. ALLOCATED via
    // replacement-reference.ts — never string-built at a use site.
    reference: text().notNull(),

    status: text().notNull().default('requested'),
    reason: text().notNull(),

    // A replacement bills nothing unless someone with authority decides it does; see
    // replacement-billability.ts for who may, and until when.
    billable: boolean().notNull().default(false),
    liabilityOwner: text('liability_owner').notNull().default('operator'),

    // Creation is idempotent on this key, which is what makes a retried create safe.
    requestIdempotencyKey: text('request_idempotency_key').notNull(),

    // Optimistic concurrency. Every transition is
    // `where id = :id and status = :expected and state_version = :v`, and zero rows updated
    // is a 409 rather than a lost update.
    stateVersion: integer('state_version').notNull().default(0),

    reviewReason: text('review_reason'),
    reviewRequestedAt: timestamp('review_requested_at', { withTimezone: true }),

    initiatedBy: text('initiated_by'),
    approvedBy: text('approved_by'),
    adminOverride: boolean('admin_override').notNull().default(false),
    adminOverrideBy: text('admin_override_by'),
    adminOverrideReason: text('admin_override_reason'),

    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    labelCreatedAt: timestamp('label_created_at', { withTimezone: true }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('replacements_reference_key').on(t.reference),
    uniqueIndex('replacements_request_idempotency_key_key').on(t.requestIdempotencyKey),
    // One shipment cannot belong to two replacements. Partial, because most rows have none.
    uniqueIndex('replacements_shipment_unq')
      .on(t.replacementShipmentId)
      .where(sql`${t.replacementShipmentId} is not null`),
    index('replacements_order_idx').on(t.orderId),
    index('replacements_client_status_idx').on(t.clientId, t.status),
    // DELIBERATELY ABSENT: a "one active replacement per order" unique index. Multiple
    // concurrent replacements against one order are required (a second item damaged later is
    // not the same event), so uniqueness here would be wrong. Ordering and reference
    // allocation are serialised under an order-scoped lock in the create command instead.
  ],
);

export const replacementItems = pgTable(
  'replacement_items',
  {
    id: serial().primaryKey(),
    replacementId: integer('replacement_id')
      .notNull()
      .references(() => replacements.id, { onDelete: 'cascade' }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    // NO FOREIGN KEY TO order_items.id, deliberately. The sync trigger regenerates those rows
    // and computes line_index as (ordinality - 1) from raw JSON array position, so a real FK
    // would either block the order refresh or follow it — and following it silently retargets
    // a replacement at a different product.
    orderLineIndex: integer('order_line_index').notNull(),

    // Frozen drift-detection fingerprint, built by replacement-source-line-fingerprint.ts.
    // Not a permanent identifier.
    sourceLineFingerprint: text('source_line_fingerprint').notNull(),

    // Frozen snapshots of what was requested. Never rewritten to follow a refreshed order:
    // a shipped replacement's facts must survive a later refresh untouched.
    sku: text().notNull(),
    name: text(),
    originalOrderedQuantity: integer('original_ordered_quantity').notNull(),

    // integer, matching the inventory ledger's quantity type.
    quantity: integer().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('replacement_items_line_unq').on(t.replacementId, t.orderLineIndex),
    index('replacement_items_replacement_idx').on(t.replacementId),
    index('replacement_items_order_idx').on(t.orderId),
  ],
);

// Append-only. RESTRICT on replacementId, so history cannot be cascade-deleted out from under
// an audit by removing its subject.
export const replacementActivityEvents = pgTable(
  'replacement_activity_events',
  {
    id: serial().primaryKey(),
    replacementId: integer('replacement_id')
      .notNull()
      .references(() => replacements.id, { onDelete: 'restrict' }),
    shipmentId: integer('shipment_id').references(() => shipments.id, { onDelete: 'set null' }),

    eventType: text('event_type').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    actorType: text('actor_type').notNull(),
    actorEmail: text('actor_email'),

    // Idempotency is what makes a retried transition safe to replay: the second attempt
    // collides here instead of appending a duplicate event.
    idempotencyKey: text('idempotency_key').notNull(),

    eventAt: timestamp('event_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('replacement_activity_events_idempotency_key_key').on(t.idempotencyKey),
    index('replacement_activity_events_replacement_idx').on(t.replacementId, t.eventAt),
  ],
);

export type ReplacementRow = typeof replacements.$inferSelect;
export type ReplacementItemRow = typeof replacementItems.$inferSelect;
export type ReplacementActivityEventRow = typeof replacementActivityEvents.$inferSelect;
