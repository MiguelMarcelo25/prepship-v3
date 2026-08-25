import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { fulfillmentOccurrences } from './fulfillment-occurrences.js';
import { inventory } from './inventory.js';
import { orders } from './orders.js';
import { shipments } from './shipments.js';

// Per user override unlock shipped data on 2026-07-16: PS-424 adds a
// review-only JSON snapshot reason; no orders/shipments column is changed.
//
// PS-497 Slice 2 (S2.0): additive occurrence-projection mapping for migration 0104's already-applied
// columns/indexes (occurrence_id on both sidecars; canonical_line_identity + supply + the two PARTIAL
// uniqueness indexes on claims). Additive/nullable only — no orders/shipments column changed, no
// writer behavior. runtime-schema-readiness enrolls these, so a deploy that lands this mapping ahead
// of 0104 fails the boot CLOSED (it never 500s a select). Deploys only after 0104 is applied to prod.

/**
 * PS-497: what the provider actually sent, when it could not be used as a quantity.
 *
 * The previous normalizer discarded the offending value and persisted a fabricated `1`, so
 * the one fact needed to diagnose an occurrence was the one fact thrown away. Production
 * carries exactly one `invalid_quantity` claim and its raw value is unrecoverable.
 *
 * Encoding is deliberately lossy for anything that could carry PII. Numbers and
 * numeric-looking strings are diagnostically useful and safe, so they are kept verbatim;
 * arbitrary strings are hashed, and objects and arrays are reduced to a type marker. This
 * value must never appear in webhook or watchdog alert text.
 */
export type QuantityEvidence = {
  inputType: 'missing' | 'number' | 'string' | 'boolean' | 'object' | 'array';
  /** The literal token when safe, a redaction marker when not, null when nothing arrived. */
  token: string | null;
  redacted: boolean;
  /** Length of the original string, kept when the content itself is not. */
  originalLength?: number;
  /** Correlates repeat occurrences of the same unsafe value without storing it. */
  sha256?: string;
};

export type FulfilledLineQuantityReviewReason =
  | 'missing_quantity'
  | 'zero_quantity'
  | 'invalid_quantity';

/** A line whose quantity was proved to be a positive integer. Only these deduct. */
type ExactFulfilledLineSnapshot = {
  lineKey: string;
  sku: string | null;
  name: string | null;
  quantity: number;
  reviewReason?: never;
  quantityEvidence?: never;
};

/**
 * A line the provider sent whose quantity could not be used.
 *
 * `quantity: null` rather than a fabricated number, and `quantityEvidence` is REQUIRED by the
 * type — not optional — so a future edit cannot quietly drop the evidence and leave the next
 * occurrence as undiagnosable as this one was.
 */
type QuantityReviewFulfilledLineSnapshot = {
  lineKey: string;
  sku: string | null;
  name: string | null;
  quantity: null;
  reviewReason: FulfilledLineQuantityReviewReason;
  quantityEvidence: QuantityEvidence;
};

/** No per-line facts were available at all, so there is no quantity to evidence. */
type UnavailableFulfilledLineSnapshot = {
  lineKey: string;
  sku: null;
  name: string | null;
  quantity: null;
  reviewReason: 'fulfillment_lines_unavailable';
  quantityEvidence?: never;
};

/**
 * PS-497: a line from a shipment that could not be identified.
 *
 * The quantity may be perfectly well known here — what is missing is WHICH product it was.
 * A deduction needs both, so these never deduct. The line is retained rather than dropped so
 * the provider fact, including the product name, survives for diagnosis.
 */
type IdentityReviewFulfilledLineSnapshot = {
  lineKey: string;
  sku: string | null;
  name: string | null;
  quantity: number | null;
  reviewReason: 'fulfillment_line_missing_sku';
  quantityEvidence?: never;
};

export type FulfilledLineSnapshot =
  | ExactFulfilledLineSnapshot
  | QuantityReviewFulfilledLineSnapshot
  | IdentityReviewFulfilledLineSnapshot
  | UnavailableFulfilledLineSnapshot;

/**
 * PS-424 source of truth: an immutable receipt for one normalized order
 * lifecycle command. Callers may translate provider payloads, but they may
 * not write terminal order state or fulfillment claims themselves.
 */
export const orderLifecycleEvents = pgTable(
  'order_lifecycle_events',
  {
    id: serial().primaryKey(),
    orderId: integer().notNull().references(() => orders.id),
    shipmentId: integer().references(() => shipments.id),
    commandKey: text().notNull(),
    transition: text().notNull(),
    source: text().notNull(),
    provenance: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    fulfilledLines: jsonb().$type<FulfilledLineSnapshot[]>().default([]).notNull(),
    effectiveAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    // S2.0 (migration 0104): the event's projection of its physical occurrence. INSERT-time only
    // (the append-only trigger blocks UPDATE); historical events stay NULL forever.
    occurrenceId: integer().references(() => fulfillmentOccurrences.id),
  },
  (t) => [
    uniqueIndex('order_lifecycle_events_command_unq').on(t.commandKey),
    index('order_lifecycle_events_order_idx').on(t.orderId, t.id),
    index('order_lifecycle_events_shipment_idx').on(t.shipmentId),
  ],
);

/**
 * Exact inventory work created by a lifecycle event. A claim is never keyed
 * only by order: shipment + fulfillment line identity is retained so split
 * shipments and relabels have independent, reversible stock movements.
 */
export const fulfillmentLineClaims = pgTable(
  'fulfillment_line_claims',
  {
    id: serial().primaryKey(),
    lifecycleEventId: integer().notNull().references(() => orderLifecycleEvents.id),
    orderId: integer().notNull().references(() => orders.id),
    shipmentId: integer().references(() => shipments.id),
    lineKey: text().notNull(),
    sku: text(),
    name: text(),
    // PS-497: nullable, because an unusable provider quantity must stay unknown rather than
    // be invented. The NOT NULL plus `CHECK (quantity > 0)` is precisely what forced the old
    // normalizer to coerce a bad value to 1. Migration 0090 replaces both with a state check:
    // a null quantity is legal ONLY on a review claim, so nothing pending, applied,
    // superseded or reversed can carry an unknown quantity into an inventory movement.
    quantity: integer(),
    direction: text().notNull(),
    originalClaimId: integer().references((): AnyPgColumn => fulfillmentLineClaims.id),
    inventoryId: integer().references(() => inventory.id),
    status: text().notNull().default('pending'),
    idempotencyKey: text().notNull(),
    attempts: integer().notNull().default(0),
    lastError: text(),
    appliedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    // S2.0 (migration 0104): occurrence-scoped identity. `occurrenceId` is the column the two PARTIAL
    // uniqueness indexes ride on (inert until Slice-2 writers set it). `canonicalLineIdentity` is the
    // ordinal-disambiguated per-physical-line identity (normalizeFulfilledLines lineKey, NEVER a bare
    // SKU). `supply` is the per-line deduction authority ('prepship' | 'external' | 'unknown').
    occurrenceId: integer().references(() => fulfillmentOccurrences.id),
    canonicalLineIdentity: text(),
    supply: text(),
  },
  (t) => [
    uniqueIndex('fulfillment_line_claims_idempotency_unq').on(t.idempotencyKey),
    index('fulfillment_line_claims_event_status_idx').on(t.lifecycleEventId, t.status),
    index('fulfillment_line_claims_shipment_idx').on(t.shipmentId, t.id),
    index('fulfillment_line_claims_original_idx').on(t.originalClaimId),
    // Hermes uniqueness key #1 (the double-deduct fix) — PARTIAL on occurrence_id (inert over legacy
    // NULL rows). Matches migration 0104's fulfillment_line_claims_occ_line_dir_unq exactly.
    uniqueIndex('fulfillment_line_claims_occ_line_dir_unq')
      .on(t.occurrenceId, t.canonicalLineIdentity, t.direction)
      .where(sql`${t.occurrenceId} is not null`),
    // Hermes uniqueness key #2 — reverse uniqueness by original_claim_id. Matches 0104's
    // fulfillment_line_claims_reverse_original_unq.
    uniqueIndex('fulfillment_line_claims_reverse_original_unq')
      .on(t.originalClaimId)
      .where(sql`${t.direction} = 'reverse' and ${t.originalClaimId} is not null`),
  ],
);

export type OrderLifecycleEvent = typeof orderLifecycleEvents.$inferSelect;
export type FulfillmentLineClaim = typeof fulfillmentLineClaims.$inferSelect;
