import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
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

    // Migration 0099. The canonical signature of the WHOLE creating request. A retry must
    // match it exactly; matching only the items let a key be reused with different money or
    // liability intent and silently return the earlier replacement. NULL on pre-0099 rows,
    // which the command treats as "cannot prove equivalence" rather than as a match.
    requestSignature: text('request_signature'),

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

    // Migration 0098. Decision 7 requires a WRITTEN REASON for a billability change and an
    // activity event; without somewhere to keep it the command validated the reason and then
    // discarded it, which is worse than not asking for one. Follows return_activity_events.
    detail: text(),

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

// PS-502 (migration 0100) — replacement-scoped label purchase intents.
//
// Deliberately NOT `label_purchase_intents`. That table's unresolved authority is keyed on
// `order_id`, and `assertNoUnresolvedLabelPurchaseIntent(orderId)` fails closed on it after
// promoting every pending row for the order. A replacement intent carries the ORIGINAL
// order's id, so sharing the table would let a stuck replacement block the original order's
// label flow — and let a check on the original mutate replacement state.
export const replacementLabelPurchaseIntents = pgTable(
  'replacement_label_purchase_intents',
  {
    id: serial().primaryKey(),
    replacementId: integer('replacement_id')
      .notNull()
      .references(() => replacements.id, { onDelete: 'restrict' }),
    replacementShipmentId: integer('replacement_shipment_id').references(() => shipments.id, {
      onDelete: 'set null',
    }),
    provider: text().notNull(),
    /** Deterministic and replacement-scoped. Never the original order's purchase key. */
    providerIdempotencyKey: text('provider_idempotency_key').notNull(),
    /** Fingerprint of the FROZEN resolved request; a retry must reuse it verbatim. */
    requestFingerprint: text('request_fingerprint').notNull(),
    purchaseAttempt: integer('purchase_attempt').notNull().default(1),
    state: text().notNull().default('provider_pending'),
    /** Stable provider identity. A tracking number is not a purchase identity. */
    providerTransactionId: text('provider_transaction_id'),
    providerLabelId: text('provider_label_id'),
    providerShipmentId: text('provider_shipment_id'),
    resolvedRequest: jsonb('resolved_request'),
    lastError: text('last_error'),
    lastErrorClass: text('last_error_class'),
    reconciliationState: text('reconciliation_state'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    voidState: text('void_state'),
    providerVoidId: text('provider_void_id'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('replacement_label_purchase_intents_key_unq').on(t.providerIdempotencyKey),
    // At most one UNRESOLVED intent per replacement — the replacement-scoped analogue of
    // label_purchase_intents_unresolved_idx, and deliberately not keyed on order_id.
    uniqueIndex('replacement_label_purchase_intents_active_unq')
      .on(t.replacementId)
      .where(sql`${t.state} in ('provider_pending', 'reconcile_required')`),
    index('replacement_label_purchase_intents_replacement_idx').on(t.replacementId, t.createdAt),
  ],
);

// PS-502 (migration 0100) — append-only remap resolutions.
//
// `replacement_items` keeps the originally REQUESTED snapshot and is never rewritten; the
// effective target is the latest remap for an item. An approved remap that overwrote the
// frozen coordinate would destroy the evidence of what was actually asked for.
export const replacementItemRemaps = pgTable(
  'replacement_item_remaps',
  {
    id: serial().primaryKey(),
    replacementId: integer('replacement_id')
      .notNull()
      .references(() => replacements.id, { onDelete: 'restrict' }),
    replacementItemId: integer('replacement_item_id')
      .notNull()
      .references(() => replacementItems.id, { onDelete: 'restrict' }),
    previousOrderLineIndex: integer('previous_order_line_index').notNull(),
    previousSourceLineFingerprint: text('previous_source_line_fingerprint').notNull(),
    resolvedOrderLineIndex: integer('resolved_order_line_index').notNull(),
    resolvedSourceLineFingerprint: text('resolved_source_line_fingerprint').notNull(),
    /** remapped | retained | rejected */
    resolution: text().notNull(),
    remapVersion: integer('remap_version').notNull().default(1),
    actorType: text('actor_type').notNull(),
    actorEmail: text('actor_email'),
    /** Required. A remap without a written reason is an unattributable retarget. */
    reason: text().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('replacement_item_remaps_idempotency_unq').on(t.idempotencyKey),
    uniqueIndex('replacement_item_remaps_item_version_unq').on(t.replacementItemId, t.remapVersion),
    index('replacement_item_remaps_replacement_idx').on(t.replacementId, t.createdAt),
  ],
);

/**
 * PS-502 AC-16 — a replacement whose original order was cancelled or refunded.
 *
 * A row here is a HOLD, not a status: it records why, what proved it, and what a human
 * still owes an answer to. The CHECK constraints live in 0101 and are deliberately not
 * expressed here — Drizzle cannot state the evidence-pointer rule, and a mapping that
 * looked complete would invite someone to trust it.
 */
export const replacementOriginalOrderHolds = pgTable(
  'replacement_original_order_holds',
  {
    id: serial().primaryKey(),
    replacementId: integer('replacement_id')
      .notNull()
      .references(() => replacements.id, { onDelete: 'restrict' }),
    orderId: integer('order_id').notNull(),
    /** order_cancelled | order_refunded — the latter is operator-declared only. */
    triggerKind: text('trigger_kind').notNull(),
    /** order_lifecycle_event | webhook_event | operator_declaration */
    evidenceKind: text('evidence_kind').notNull(),
    orderLifecycleEventId: integer('order_lifecycle_event_id'),
    webhookEventId: integer('webhook_event_id'),
    declaredBy: text('declared_by'),
    /** Human prose. Never parsed — identity comes from the evidence pointer. */
    reason: text().notNull(),
    /** pre_dispatch | pre_dispatch_label_at_risk | post_dispatch | terminal_no_action */
    phase: text().notNull(),
    /** cancelled | review | flagged_post_dispatch | no_action */
    disposition: text().notNull(),
    /** Null unless a human still owes an answer. */
    openQuestion: text('open_question'),
    statusAtHold: text('status_at_hold').notNull(),
    stateVersionAtHold: integer('state_version_at_hold').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    resolution: text(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('replacement_original_order_holds_idempotency_unq').on(t.idempotencyKey),
    index('replacement_original_order_holds_order_idx').on(t.orderId, t.createdAt),
  ],
);

export type ReplacementOriginalOrderHoldRow = typeof replacementOriginalOrderHolds.$inferSelect;

/**
 * PS-502 AC-13 (migration 0103) — a durable financial decision, separate from lifecycle.
 *
 * Per user override `unlock shipped data` on 2026-08-19: shipped replacements keep their
 * lifecycle history. This row is the retry authority for removing only replacement-scoped
 * editable lines and creating replacement-attributed append-only credits.
 */
export const replacementFinancialActions = pgTable(
  'replacement_financial_actions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    replacementId: integer('replacement_id')
      .notNull()
      .references(() => replacements.id, { onDelete: 'restrict' }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    actionType: text('action_type').notNull(),
    reason: text().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedByType: text('requested_by_type').notNull(),
    requestedByEmail: text('requested_by_email'),
    status: text().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    editableRemoved: integer('editable_removed').notNull().default(0),
    creditsSettled: integer('credits_settled').notNull().default(0),
    creditedAmount: numeric('credited_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    lastError: text('last_error'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('replacement_financial_actions_idempotency_unq').on(t.idempotencyKey),
    index('replacement_financial_actions_replacement_idx').on(t.replacementId, t.createdAt),
    index('replacement_financial_actions_client_idx').on(t.clientId, t.createdAt),
    index('replacement_financial_actions_due_idx')
      .on(t.nextRunAt, t.id)
      .where(sql`${t.status} in ('pending', 'retry', 'processing')`),
  ],
);

export type ReplacementFinancialActionRow = typeof replacementFinancialActions.$inferSelect;

export type ReplacementLabelPurchaseIntentRow = typeof replacementLabelPurchaseIntents.$inferSelect;
export type ReplacementItemRemapRow = typeof replacementItemRemaps.$inferSelect;
