import {
  bigint,
  bigserial,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// PS-509 — durable sync-ingress customer-money outcomes and the
// receipt-revised-after-freeze review class. Migration 0103 owns both relations,
// their partial indexes and their mutation-guard triggers; this file only mirrors
// the shape for typed access. Money is NOT stored here: the frozen tuple lives in
// shipments.selected_rate_json under its policy-version key. Outcomes carry
// classification, provenance and timing only.

export const customerShippingMoneySyncOutcomes = pgTable(
  'customer_shipping_money_sync_outcomes',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    shipmentId: integer().notNull(),
    labelShipmentId: bigint({ mode: 'number' }),
    boundary: text().notNull(),
    outcome: text().notNull(),
    policyContract: text().default('ps-509-v1').notNull(),
    orderId: integer(),
    clientId: integer(),
    failureClassification: text(),
    detail: text(),
    evaluationCount: integer().default(1).notNull(),
    firstEvaluatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    lastEvaluatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('csm_sync_outcomes_shipment_unq').on(t.shipmentId),
    index('csm_sync_outcomes_outcome_idx').on(t.outcome),
  ],
);

export type CustomerShippingMoneySyncOutcomeRow =
  typeof customerShippingMoneySyncOutcomes.$inferSelect;

export const customerShippingMoneyReceiptRevisions = pgTable(
  'customer_shipping_money_receipt_revisions',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    shipmentId: integer().notNull(),
    reviewClass: text().default('receipt_revised_after_freeze').notNull(),
    policyVersion: text().notNull(),
    previousFrozenSelectedCost: numeric({ precision: 12, scale: 2 }).notNull(),
    currentPostageCost: numeric({ precision: 12, scale: 2 }),
    currentOtherCost: numeric({ precision: 12, scale: 2 }),
    deltaSigned: numeric({ precision: 12, scale: 2 }).notNull(),
    deltaAbs: numeric({ precision: 12, scale: 2 }).notNull(),
    clientId: integer(),
    source: text(),
    reconciliationState: text().default('open').notNull(),
    resolvedAt: timestamp({ withTimezone: true }),
    resolvedBy: text(),
    resolutionNote: text(),
    detectionCount: integer().default(1).notNull(),
    firstDetectedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    lastDetectedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('csm_receipt_revisions_shipment_idx').on(t.shipmentId),
    index('csm_receipt_revisions_state_idx').on(t.reconciliationState, t.firstDetectedAt),
  ],
);

export type CustomerShippingMoneyReceiptRevisionRow =
  typeof customerShippingMoneyReceiptRevisions.$inferSelect;
