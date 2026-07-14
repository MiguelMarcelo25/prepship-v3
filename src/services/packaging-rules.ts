/**
 * PS-223 — packaging rule engine.
 *
 * Given DJ's per-client SKU classification (client_sku_classes) and packing rules
 * (client_packing_rules), the engine turns an order's items into a packaging
 * decision:
 *
 *   order_items → sum qty by class → deterministic signature (ruleKey)
 *               → matched packing rule → catalog package.
 *
 * This module ships the ENGINE + a READ-ONLY dry-run planner. It writes NOTHING
 * to orders/defaults. A later apply pass would upsert the order's combo default,
 * NEVER overwriting an operator-set default (client_combo_package_defaults.source
 * = 'operator') and only on awaiting_shipment orders without an active label —
 * exactly the PS-205 precedence + PS-082 awaiting-only guards. The pure functions
 * below are the testable core (see scripts/ps-223-packaging-rule-engine-guard.ts).
 */
import { sql } from '../db/client';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';
import { computeComboKey } from '../lib/package-combo.js';
import {
  classifySkuTotals,
  computeRuleKey,
  matchPackingRule,
  signatureHasUnclassified,
  type PackingItem,
  type PackingRule,
} from '../lib/packaging-rules-core.js';

// Re-export the pure core so callers have one import surface.
export {
  classifySkuTotals,
  computeRuleKey,
  matchPackingRule,
  signatureHasUnclassified,
  UNCLASSIFIED,
  type PackingItem,
  type PackingRule,
} from '../lib/packaging-rules-core.js';

// ── Schema ensure (idempotent, mirrors drizzle/0047) ────────────────────────

export async function ensurePackagingRulesSchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}

// ── Read-only dry-run planner ───────────────────────────────────────────────

export type PackagingPlanAction =
  | 'assign'
  | 'skip:no-rule'
  | 'skip:unclassified'
  | 'skip:operator-default'
  | 'skip:no-items';

export interface PackagingPlanRow {
  orderId: number;
  clientId: number;
  orderNumber: string | null;
  ruleKey: string;
  matchedPackageId: number | null;
  action: PackagingPlanAction;
}

export interface PackagingPlanReport {
  classesTotal: number;
  rulesTotal: number;
  clientsConfigured: number;
  ordersConsidered: number;
  wouldAssign: number;
  rows: PackagingPlanRow[];
}

/** Compute (but never write) the packaging assignment the engine WOULD make for
 *  awaiting orders. Read-only. */
export async function planPackagingForAwaitingOrders(
  opts: { clientId?: number; limit?: number } = {},
): Promise<PackagingPlanReport> {
  await ensurePackagingRulesSchema();
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000));

  // Config: SKU classes + packing rules, grouped by client.
  const classRows = opts.clientId != null
    ? await sql<{ client_id: number; sku: string; class_name: string }[]>`
        select client_id, sku, class_name from client_sku_classes where client_id = ${opts.clientId}`
    : await sql<{ client_id: number; sku: string; class_name: string }[]>`
        select client_id, sku, class_name from client_sku_classes`;
  const ruleRows = opts.clientId != null
    ? await sql<{ client_id: number; rule_key: string; package_id: number | null; package_code: string | null; priority: number }[]>`
        select client_id, rule_key, package_id, package_code, priority from client_packing_rules where client_id = ${opts.clientId}`
    : await sql<{ client_id: number; rule_key: string; package_id: number | null; package_code: string | null; priority: number }[]>`
        select client_id, rule_key, package_id, package_code, priority from client_packing_rules`;

  const classByClient = new Map<number, Map<string, string>>();
  for (const r of classRows) {
    const m = classByClient.get(r.client_id) ?? new Map<string, string>();
    m.set(r.sku.trim().toLowerCase(), r.class_name);
    classByClient.set(r.client_id, m);
  }
  const rulesByClient = new Map<number, PackingRule[]>();
  for (const r of ruleRows) {
    const list = rulesByClient.get(r.client_id) ?? [];
    list.push({ ruleKey: r.rule_key, packageId: r.package_id, packageCode: r.package_code, priority: r.priority });
    rulesByClient.set(r.client_id, list);
  }
  const clientsConfigured = new Set([...classByClient.keys(), ...rulesByClient.keys()]).size;

  // Awaiting orders (id + client) — limited.
  const orderRows = opts.clientId != null
    ? await sql<{ id: number; client_id: number; order_number: string | null }[]>`
        select id, client_id, order_number from orders
        where order_status = 'awaiting_shipment' and client_id is not null and client_id = ${opts.clientId}
        order by id desc limit ${limit}`
    : await sql<{ id: number; client_id: number; order_number: string | null }[]>`
        select id, client_id, order_number from orders
        where order_status = 'awaiting_shipment' and client_id is not null
        order by id desc limit ${limit}`;
  const orderIds = orderRows.map((o) => o.id);

  // Items for those orders (porsager binds the array natively).
  const itemRows = orderIds.length
    ? await sql<{ order_id: number; sku: string; quantity: string }[]>`
        select order_id, sku, quantity from order_items
        where order_id = any(${orderIds}) and quantity > 0`
    : [];
  const itemsByOrder = new Map<number, PackingItem[]>();
  for (const r of itemRows) {
    const list = itemsByOrder.get(r.order_id) ?? [];
    list.push({ sku: r.sku, quantity: Number(r.quantity) });
    itemsByOrder.set(r.order_id, list);
  }

  // Operator-owned defaults to protect: (clientId, comboKey) where source='operator'.
  const operatorDefaults = orderIds.length
    ? await sql<{ client_id: number; combo_key: string }[]>`
        select client_id, combo_key from client_combo_package_defaults where source = 'operator'`
    : [];
  const operatorSet = new Set(operatorDefaults.map((d) => `${d.client_id}:${d.combo_key}`));

  const rows: PackagingPlanRow[] = [];
  let wouldAssign = 0;
  for (const o of orderRows) {
    const items = itemsByOrder.get(o.id) ?? [];
    const classMap = classByClient.get(o.client_id) ?? new Map<string, string>();
    const rules = rulesByClient.get(o.client_id) ?? [];
    let action: PackagingPlanAction;
    let matchedPackageId: number | null = null;
    let ruleKey = '';

    if (!items.length) {
      action = 'skip:no-items';
    } else {
      ruleKey = computeRuleKey(classifySkuTotals(items, classMap));
      const comboKey = computeComboKey(items.map((it) => ({ sku: it.sku, quantity: it.quantity })));
      if (operatorSet.has(`${o.client_id}:${comboKey}`)) {
        action = 'skip:operator-default';
      } else if (signatureHasUnclassified(ruleKey)) {
        action = 'skip:unclassified';
      } else {
        const rule = matchPackingRule(ruleKey, rules);
        if (rule) { action = 'assign'; matchedPackageId = rule.packageId; wouldAssign += 1; }
        else action = 'skip:no-rule';
      }
    }
    rows.push({ orderId: o.id, clientId: o.client_id, orderNumber: o.order_number, ruleKey, matchedPackageId, action });
  }

  return {
    classesTotal: classRows.length,
    rulesTotal: ruleRows.length,
    clientsConfigured,
    ordersConsidered: orderRows.length,
    wouldAssign,
    rows,
  };
}
