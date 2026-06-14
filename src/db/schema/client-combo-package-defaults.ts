import {
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { packages } from './packages.js';

// PS-037 — Per-client package defaults keyed by the EXACT SKU+qty combination
// of an order (not by individual SKU). Lets mixed-SKU clients (e.g. Hugrab:
// Booster-gel-001 + HU-10 in varying quantities) save a package once per
// combination and have future Awaiting Shipment orders with the same client +
// same SKUs + same quantities auto-select it.
//
// comboKey is the deterministic key from src/lib/package-combo.ts
// (lowercased+trimmed SKUs, duplicate lines summed, sorted, qty-sensitive),
// e.g. "booster-gel-001:2|hu-10:1". Always derived server-side from real order
// items — never trusted from the client. Scoped by clientId; uniqueness on
// (clientId, comboKey) makes save an upsert and prevents cross-client leakage.
export const clientComboPackageDefaults = pgTable(
  'client_combo_package_defaults',
  {
    id: serial().primaryKey(),
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    comboKey: text().notNull(),
    // Selected package (matches packages.id; getPackageIdentifier() returns its
    // string form on the frontend). packageCode kept as a resilience fallback.
    packageId: integer().references(() => packages.id),
    packageCode: text(),
    // Dims/weight snapshot used when the default was saved, so rate/package
    // selection can proceed without re-deriving from product defaults.
    length: real(),
    width: real(),
    height: real(),
    weightOz: real(),
    // PS-223 — provenance. An operator-set default ('operator') is never overwritten
    // by the packaging rule engine (which writes 'rule_engine'); 'import' marks one
    // materialized from a store import. Defaults to 'operator' so every PRE-EXISTING
    // row is treated as operator-owned — the safe, conservative choice.
    source: text().notNull().default('operator'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('client_combo_package_defaults_client_combo_idx').on(t.clientId, t.comboKey),
    index('client_combo_package_defaults_client_idx').on(t.clientId),
  ]
);

export type ClientComboPackageDefault = typeof clientComboPackageDefaults.$inferSelect;
export type NewClientComboPackageDefault = typeof clientComboPackageDefaults.$inferInsert;
