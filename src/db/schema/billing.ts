import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clients } from './clients.js';
import { orders } from './orders.js';
import { shipments } from './shipments.js';
import { packages } from './packages.js';
import { returns } from './returns.js';

// Source-of-truth note: billing_config owns mutable billing rules. Generated
// billing_line_items should be treated as frozen billable records.
export const billingConfig = pgTable('billing_config', {
  clientId: integer()
    .primaryKey()
    .references(() => clients.id, { onDelete: 'cascade' }),
  pickPackFee: numeric({ precision: 10, scale: 2 }).default('0').notNull(),
  // Threshold — orders with units ≤ pickPackMaxUnits pay only pickPackFee.
  // Units beyond the threshold are charged additionalUnitFee each.
  // Default 1 matches v2's hardcoded constant (one included unit per order).
  pickPackMaxUnits: integer('pick_pack_max_units').default(1).notNull(),
  additionalUnitFee: numeric({ precision: 10, scale: 2 }).default('0').notNull(),
  packageCostMarkup: numeric({ precision: 5, scale: 2 }).default('0').notNull(),
  shippingMarkupPct: numeric({ precision: 5, scale: 2 }).default('0').notNull(),
  shippingMarkupFlat: numeric({ precision: 10, scale: 2 }).default('0').notNull(),
  // Monthly storage fee in dollars per cubic-foot of inventory on hand.
  // v2 computed storage line items from inventory_ledger deltas × cuFtOverride
  // (or default L×W×H/1728). 0 disables storage billing entirely.
  storageFeePerCuFt: numeric('storage_fee_per_cu_ft', { precision: 10, scale: 4 })
    .default('0')
    .notNull(),
  billingMode: text().default('per_shipment').notNull(),
  active: boolean().default(true).notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const billingLineItems = pgTable(
  'billing_line_items',
  {
    id: serial().primaryKey(),
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    orderId: integer().references(() => orders.id),
    orderNumber: text(),
    shipmentId: integer().references(() => shipments.id),
    // PS-488 M1 — relational return identity (migration 0089).
    //
    // NULL means "not yet attributed", NOT "not a return line". Every row predates M2,
    // so readers must not infer anything from NULL until M2 writers have shipped and
    // been proved. PS-487 AC-7 needs this to record which billing rows a date
    // correction touched; parsing the event key out of `description` is not relational
    // identity, and order_id + line_type mis-attributes the moment an order has a
    // second return.
    //
    // PS-488 recovery (migration 0092): ON DELETE RESTRICT, not SET NULL. 0089
    // shipped SET NULL, which would silently detach a billing line from the return
    // that produced it when that return was deleted — losing the linkage on a money
    // row rather than refusing the delete. RESTRICT makes the database refuse
    // instead. A billing line is still financial history; the way to protect it is
    // to prevent the delete, not to quietly null the evidence.
    returnId: integer('return_id').references(() => returns.id, { onDelete: 'restrict' }),
    shipDate: timestamp({ withTimezone: true }),
    // PS-434: shipDate remains the actual activity calendar day. This nullable
    // field is the invoice/range bucket; NULL preserves all legacy rows through
    // coalesce(billing_effective_date, ship_date) without a historical backfill.
    billingEffectiveDate: timestamp('billing_effective_date', { withTimezone: true }),
    billingPolicyVersion: text('billing_policy_version'),
    lineType: text().notNull(),
    description: text().notNull(),
    qty: numeric({ precision: 10, scale: 2 }).default('1').notNull(),
    unitCost: numeric({ precision: 10, scale: 2 }).notNull(),
    totalCost: numeric({ precision: 10, scale: 2 }).notNull(),
    // PS — billing-line-only Box Size override. When set, the Edit Billing
    // Detail modal changed this row's box; billingDetails uses this package for
    // the box name/dims instead of the shipment-derived package. Never mutates
    // the shipment's selectedPackageId.
    packageId: integer().references(() => packages.id),
    // PS-449: append-only correction projections live in the current billing
    // period while retaining an explicit reference to the frozen invoice fact.
    // The composite foreign keys are migration-owned because the referenced
    // tables are declared below this table in the Drizzle schema.
    sourceFinalizationId: text('source_finalization_id'),
    billingAdjustmentId: text('billing_adjustment_id'),
    invoiced: boolean().default(false).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('billing_li_client_idx').on(t.clientId),
    index('billing_li_date_idx').on(t.shipDate),
    index('billing_li_effective_date_idx').on(
      sql`coalesce(${t.billingEffectiveDate}, ${t.shipDate})`,
    ),
    // PS-425: distinct outbound shipments retain their own frozen charge and
    // margin lineage. Shipment-less external/order rows keep their order-level
    // identity, while storage (orderId NULL) remains on its period-specific key.
    uniqueIndex('billing_li_shipment_unique_idx')
      .on(t.orderId, t.shipmentId, t.lineType, t.description)
      .where(sql`${t.shipmentId} is not null`),
    uniqueIndex('billing_li_order_unique_idx')
      .on(t.orderId, t.lineType, t.description)
      .where(sql`${t.orderId} is not null and ${t.shipmentId} is null`),
    // Audit B-4 (2026-07-13): storage lines carry orderId NULL, and Postgres
    // Storage rows all have orderId/shipmentId NULL, so their period identity
    // uses this client/date key. This partial
    // unique closes the hole at the DB layer (created on prod via migration
    // audit_2026_07_13_week1_indexes_and_rls; zero violations existed). The
    // generator also takes an xact advisory lock, and RETURNING exposes any
    // last-resort conflict no-op instead of reporting a duplicate charge.
    uniqueIndex('billing_li_storage_unique_idx')
      .on(t.clientId, t.lineType, t.shipDate, t.description)
      .where(sql`${t.orderId} is null`),
    // PS-462: proof/description changes cannot mint a second storage charge for
    // the same client + UTC calendar month.
    uniqueIndex('billing_li_storage_month_unq')
      .on(t.clientId, sql`date_trunc('month', ${t.shipDate} at time zone 'UTC')`)
      .where(sql`${t.orderId} is null and ${t.lineType} = 'storage' and ${t.shipDate} is not null`),
    uniqueIndex('billing_li_adjustment_unq')
      .on(t.billingAdjustmentId)
      .where(sql`${t.billingAdjustmentId} is not null`),
    index('billing_li_source_finalization_idx').on(t.sourceFinalizationId),
    // PS-488 M1 (migration 0089). Partial: the only question this column answers is
    // "which billing rows belong to this return", and NULL is never that answer —
    // neither for pre-M2 rows nor for non-return lines.
    index('billing_li_return_id_idx')
      .on(t.returnId)
      .where(sql`${t.returnId} is not null`),
    // PS-488 recovery (migration 0092): at most one postage row and one processing
    // row per return. Without this, one return could accumulate duplicate charges of
    // the same kind and each would look individually legitimate.
    uniqueIndex('billing_li_return_identity_unq')
      .on(t.returnId, t.lineType)
      .where(sql`${t.returnId} is not null`),
    // PS-488 recovery (migration 0092): a non-null return_id may carry ONLY
    // 'return_postage' or 'return_processing_fee'.
    //
    // This constraint is MIGRATION-OWNED, not declared here. Drizzle's table-level
    // check() would emit its own constraint definition, and 0092 adds the CHECK as
    // NOT VALID and then VALIDATEs it separately so the scan takes a weaker lock.
    // Declaring an approximation here would produce a second, subtly different
    // definition and make drizzle-kit propose a spurious drop/recreate against a
    // validated production constraint. The authoritative text lives in
    // drizzle/0092_ps488_return_identity_reconciliation.sql as
    // billing_li_return_id_canonical_type_check, and the runner pins it by exact
    // catalog definition.
  ]
);

export type BillingConfig = typeof billingConfig.$inferSelect;
export type NewBillingConfig = typeof billingConfig.$inferInsert;
export type BillingLineItem = typeof billingLineItems.$inferSelect;

// Audit 3.6 / B-2: immutable billing-close records. billing_line_items remains
// the frozen invoice truth; this table records which exact client/period was
// closed and the totals that were frozen in that transaction.
export const billingFinalizations = pgTable(
  'billing_finalizations',
  {
    id: text().primaryKey(),
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    periodStart: timestamp({ withTimezone: true }).notNull(),
    periodEnd: timestamp({ withTimezone: true }).notNull(),
    lineCount: integer().notNull(),
    orderCount: integer().notNull(),
    subtotal: numeric({ precision: 12, scale: 2 }).notNull(),
    finalizedBy: text().notNull(),
    finalizedByEmail: text(),
    finalizedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('billing_finalizations_client_period_unq').on(
      t.clientId,
      t.periodStart,
      t.periodEnd,
    ),
    unique('billing_finalizations_id_client_unq').on(t.id, t.clientId),
  ],
);

// Corrections never rewrite finalized lines. A credit note is its own
// immutable, reason-required money record tied to one finalization.
export const billingCreditNotes = pgTable(
  'billing_credit_notes',
  {
    id: text().primaryKey(),
    finalizationId: text()
      .notNull()
      .references(() => billingFinalizations.id, { onDelete: 'restrict' }),
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    amount: numeric({ precision: 12, scale: 2 }).notNull(),
    // Legacy rows are credits. New PS-449 writes also support debit notes and
    // always stamp the backend-owned current billing day.
    adjustmentKind: text('adjustment_kind').default('credit').notNull(),
    adjustmentSource: text('adjustment_source').default('manual').notNull(),
    sourceOrderId: integer('source_order_id').references(() => orders.id, { onDelete: 'restrict' }),
    postingVersion: text('posting_version').default('legacy_credit_v1').notNull(),
    effectiveDate: timestamp('effective_date', { withTimezone: true }),
    billingPolicyVersion: text('billing_policy_version'),
    reason: text().notNull(),
    idempotencyKey: text().notNull(),
    createdBy: text().notNull(),
    createdByEmail: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('billing_credit_notes_idempotency_unq').on(t.idempotencyKey),
    unique('billing_credit_notes_id_client_unq').on(t.id, t.clientId),
    index('billing_credit_notes_finalization_idx').on(t.finalizationId, t.createdAt),
    index('billing_credit_notes_source_order_idx')
      .on(t.finalizationId, t.sourceOrderId, t.createdAt)
      .where(sql`${t.sourceOrderId} is not null`),
  ],
);

export type BillingFinalization = typeof billingFinalizations.$inferSelect;
export type BillingCreditNote = typeof billingCreditNotes.$inferSelect;

export const clientPackagePrices = pgTable(
  'client_package_prices',
  {
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    packageId: integer().notNull(),
    price: numeric({ precision: 10, scale: 2 }).notNull(),
    isCustom: boolean().default(false).notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('client_package_prices_pk_idx').on(t.clientId, t.packageId),
  ]
);

export const billingRefRates = pgTable(
  'billing_ref_rates',
  {
    id: serial().primaryKey(),
    weightOz: integer(),
    zipTo: text(),
    carrier: text(),
    service: text(),
    cost: numeric({ precision: 10, scale: 2 }),
    source: text(),
    fetchedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('billing_ref_rates_lookup_idx').on(t.weightOz, t.zipTo, t.carrier),
    unique('billing_ref_rates_identity_unq')
      .on(t.weightOz, t.zipTo, t.carrier, t.service)
      .nullsNotDistinct(),
  ]
);

export type ClientPackagePrice = typeof clientPackagePrices.$inferSelect;
export type BillingRefRate = typeof billingRefRates.$inferSelect;

// PS-207: operator review resolutions for shipped-box billing. One row per
// order — an EXPLICIT operator directive ("bill this order as box X and/or at
// price Y") that the generator consults FIRST, before any shipment evidence.
// Range regeneration deletes/recreates billing_line_items only; it must NEVER
// touch this table — that persistence is the whole point (pre-PS-207, manual
// box-line edits were wiped by every regenerate).
// overridePrice is the FINAL line amount (no markup applied) so a regenerate
// reproduces exactly what the operator set in the Edit Billing Detail modal.
export const billingBoxResolutions = pgTable(
  'billing_box_resolutions',
  {
    id: serial().primaryKey(),
    orderId: integer()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    shipmentId: integer().references(() => shipments.id),
    packageId: integer().references(() => packages.id),
    overridePrice: numeric({ precision: 10, scale: 2 }),
    note: text(),
    resolvedBy: text(),
    resolvedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('billing_box_resolutions_order_unq').on(t.orderId)]
);

export type BillingBoxResolution = typeof billingBoxResolutions.$inferSelect;

// PS-498 — the canonical owner of an order's operator-authored billing DESCRIPTION.
//
// One row per order holding the sentence the operator wrote to explain why that
// order's invoice line was corrected, plus who wrote it and when. Captured per
// row by the Import Box Size & Shipping grid; rendered READ-ONLY in the Edit
// Billing Detail modal.
//
// It is NOT a box decision and NOT a money input: generateLineItems never reads
// this table, and regeneration (which deletes/recreates billing_line_items) must
// never touch it. Unlike the `note` column on billingBoxResolutions,
// billingFeeWaivers and billing_manual_overrides — all of which are synthesized
// from the edit `reason` on every save — this value is written ONLY when the
// caller explicitly supplies one, so a later manual edit cannot clobber it.
export const billingOrderDescriptions = pgTable('billing_order_descriptions', {
  orderId: integer()
    .primaryKey()
    .references(() => orders.id, { onDelete: 'cascade' }),
  description: text().notNull(),
  savedBy: text(),
  savedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type BillingOrderDescription = typeof billingOrderDescriptions.$inferSelect;

// PS-373 (slice 2) — frozen per-period storage-billing PROOF sidecar.
//
// The one `storage` billing_line_items row carries only a display total and a
// short description; it CANNOT hold the structured per-SKU / per-interval
// evidence (segments, clamped negatives, daily rate) that a client dispute or
// admin audit needs — and its description is part of the line's onConflict
// unique key, so it can't be widened without forking idempotency. This sidecar
// freezes computeClientStorageBilling()'s full proof at generate time, keyed by
// the billing PERIOD (clientId + the canonical UTC-midnight [periodStart,
// periodEnd) bounds). Additive, no order/shipment coupling. Upserted per
// client+period on each Update Billing so it always matches the latest line.
export const billingStorageProof = pgTable(
  'billing_storage_proof',
  {
    id: serial().primaryKey(),
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    // Canonical billing-period bounds (billingDayRange): periodStart is the
    // INCLUSIVE UTC midnight of the first day; periodEnd is the EXCLUSIVE UTC
    // midnight of the day AFTER the last billed day. Same instants billing.ts
    // stamps from generateLineItems' input, so a read matches exactly.
    periodStart: timestamp({ withTimezone: true }).notNull(),
    periodEnd: timestamp({ withTimezone: true }).notNull(),
    daysInMonth: integer('days_in_month').notNull(),
    monthlyRatePerCuFt: numeric('monthly_rate_per_cu_ft', { precision: 10, scale: 4 }).notNull(),
    dailyRatePerCuFt: numeric('daily_rate_per_cu_ft', { precision: 18, scale: 10 }).notNull(),
    totalCuFtDays: numeric('total_cu_ft_days', { precision: 18, scale: 6 }).notNull(),
    amount: numeric({ precision: 10, scale: 2 }).notNull(),
    skuCount: integer('sku_count').notNull(),
    exceptionCount: integer('exception_count').notNull(),
    // { skuProofs: SkuStorageProof[], exceptions: [...] } — the frozen evidence.
    proof: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('billing_storage_proof_client_period_unq').on(t.clientId, t.periodStart, t.periodEnd),
  ]
);

export type BillingStorageProof = typeof billingStorageProof.$inferSelect;
