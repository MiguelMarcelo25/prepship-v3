import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { packages } from './packages.js';

// PS-223 — the packaging RULE ENGINE storage.
//
// Two tables, both per-client and additive (no existing behavior depends on them
// until DJ seeds the 53-SKU classification + rules 1–9):
//
//   client_sku_classes   — maps a SKU to a packaging "class" (e.g. small/large item).
//   client_packing_rules — maps a class-count SIGNATURE to a catalog package.
//
// At plan time the engine: order_items → sum qty by class → build a deterministic
// signature (ruleKey) → match a packing rule → resolve the catalog package → (in a
// future apply pass) upsert the order's combo default, NEVER overwriting an
// operator-set default (client_combo_package_defaults.source = 'operator').

export const clientSkuClasses = pgTable(
  'client_sku_classes',
  {
    id: serial().primaryKey(),
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    sku: text().notNull(),
    className: text('class_name').notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('client_sku_classes_client_sku_idx').on(t.clientId, t.sku),
    index('client_sku_classes_client_idx').on(t.clientId),
  ]
);

export const clientPackingRules = pgTable(
  'client_packing_rules',
  {
    id: serial().primaryKey(),
    clientId: integer()
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    // Deterministic class-count signature, e.g. "large:2|small:1" (see computeRuleKey).
    ruleKey: text('rule_key').notNull(),
    packageId: integer('package_id').references(() => packages.id),
    packageCode: text('package_code'),
    priority: integer().notNull().default(0),
    source: text().notNull().default('rule_engine'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('client_packing_rules_client_key_idx').on(t.clientId, t.ruleKey),
    index('client_packing_rules_client_idx').on(t.clientId),
  ]
);

export type ClientSkuClass = typeof clientSkuClasses.$inferSelect;
export type ClientPackingRule = typeof clientPackingRules.$inferSelect;
