// PS-276 (slice 2) — additive per-ADDRESS residential/commercial validation cache.
//
// Address-keyed (NOT order-keyed): a repeat customer / reorder reuses one carrier
// address-validation result across orders and clients. Stores ONLY address-derived
// evidence (USPS business marker, UPS/FedEx provider classification) — never the
// order's manual override or source flag (those are combined per-order at classify
// time). The classifier (classifyShippingAddress) reads this as its trusted tiers
// 2 (providerMarker) + 4 (addressValidation).
//
// Lockdown: additive table only. No shipped/cancelled data, no shipments writes.
// Managed by the runtime ensure (address-classification-cache.ts) + the hand-written
// drizzle/0048 migration — NOT in drizzle.config.ts (same as shipment_tracking_status
// / audit_log) so it never 500s prod before the migration runs.
import { boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const addressClassifications = pgTable(
  'address_classifications',
  {
    // normalized: COUNTRY|ZIP(+4)|STATE|street1 (addressClassificationKey)
    addressKey: text().primaryKey(),
    // USPS business marker normalized: 'Y' -> true (commercial), 'N' -> false (residential), else null
    business: boolean(),
    // UPS/FedEx explicit verdict: 'residential' | 'commercial' | null (MIXED/UNKNOWN -> null, money-safe)
    providerClassification: text(),
    // which resolver set the trusted evidence: 'usps' | 'ups' | 'fedex' | null
    provider: text(),
    dpvConfirmation: text(),
    zipPlus4: text(),
    carrierRoute: text(),
    // sanitized resolver payload for diagnostics (no PII beyond the address itself)
    raw: jsonb().$type<unknown>(),
    resolvedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index('address_classifications_expires_idx').on(t.expiresAt)],
);

export type AddressClassificationRow = typeof addressClassifications.$inferSelect;
export type NewAddressClassificationRow = typeof addressClassifications.$inferInsert;
