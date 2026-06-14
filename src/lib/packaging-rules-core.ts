/**
 * PS-223 — packaging rule engine PURE CORE (no IO).
 *
 * Separated from src/services/packaging-rules.ts so it is unit-testable offline
 * (the service imports the DB client). The flow: order_items → sum qty by class
 * → deterministic signature (ruleKey) → matched packing rule.
 */

// SKUs with no class fall here so the signature reflects them and matches no rule.
export const UNCLASSIFIED = '__unclassified__';

export interface PackingItem {
  sku: string;
  quantity: number;
}
export interface PackingRule {
  ruleKey: string;
  packageId: number | null;
  packageCode: string | null;
  priority: number;
}

/** Sum order quantities by packaging class. Unknown SKUs bucket under
 *  UNCLASSIFIED; qty normalized to a positive integer (matches package-combo). */
export function classifySkuTotals(
  items: ReadonlyArray<PackingItem>,
  classMap: ReadonlyMap<string, string>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const it of items) {
    const sku = (it?.sku ?? '').trim().toLowerCase();
    if (!sku) continue;
    const raw = Number(it.quantity);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const qty = Math.max(1, Math.round(raw));
    const cls = classMap.get(sku) ?? UNCLASSIFIED;
    totals.set(cls, (totals.get(cls) ?? 0) + qty);
  }
  return totals;
}

/** Deterministic class-count signature, e.g. "large:2|small:1". Sorted by class
 *  name, zero counts excluded. Empty input → '' (matches no rule). */
export function computeRuleKey(classTotals: ReadonlyMap<string, number>): string {
  return [...classTotals.entries()]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([cls, n]) => `${cls}:${n}`)
    .join('|');
}

/** True when the signature contains any unclassified items — the engine must not
 *  assign a package it can't justify. */
export function signatureHasUnclassified(ruleKey: string): boolean {
  return ruleKey.split('|').some((part) => part.startsWith(`${UNCLASSIFIED}:`));
}

/** Exact-signature match; highest priority wins (the unique (client, rule_key)
 *  index makes ties unlikely, but priority keeps the choice deterministic). */
export function matchPackingRule(ruleKey: string, rules: ReadonlyArray<PackingRule>): PackingRule | null {
  if (!ruleKey) return null;
  let best: PackingRule | null = null;
  for (const r of rules) {
    if (r.ruleKey !== ruleKey) continue;
    if (!best || r.priority > best.priority) best = r;
  }
  return best;
}
