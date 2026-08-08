/**
 * marketplace-fee.ts — PS-239 backend owner of the per-store/client marketplace-fee
 * RULES (stored once in the `marketplace_fee_rules` settings KV, modeled on
 * the former settings-backed shipping controls). The fee MATH lives in the pure rate-money module
 * (computeMarketplaceFee); this module owns rule storage + most-specific-wins
 * resolution + the product-subtotal derivation. The orders route loads the rules
 * once per request and resolves a rule per row; the workflow DTO computes the
 * displayed fee/profit. FE renders only — no fee math on the client.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
// PS-457: cents round through the ONE owner, not a local Math.round(x * 100) / 100.
import { roundMoney } from '../lib/money';
import { settings } from '../db/schema/settings';
import type { MarketplaceFeeRule } from './shipping-workflow/rate-money';

export const MARKETPLACE_FEE_RULES_KEY = 'marketplace_fee_rules';

// Tiered defaults (card-confirmed): >= $15 → 15%, < $15 → 8%; all editable.
const DEFAULT_THRESHOLD = 15;
const DEFAULT_BELOW_PERCENT = 8;
const DEFAULT_AT_OR_ABOVE_PERCENT = 15;

export type StoredMarketplaceFeeRule = {
  clientId?: number | null;
  storeId?: number | null;
  marketplace?: string | null;
  kind: 'flat' | 'tiered';
  percent?: number | null;
  threshold?: number | null;
  belowPercent?: number | null;
  atOrAbovePercent?: number | null;
  disabled?: boolean;
};

export type MarketplaceFeeScope = {
  clientId?: number | null;
  storeId?: number | null;
  marketplace?: string | null;
};

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normMarketplace(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return s ? s : null;
}

/** Parse the `marketplace_fee_rules` settings VALUE ({version, rules:[]}) → rules. */
export function parseMarketplaceFeeRules(raw: unknown): StoredMarketplaceFeeRule[] {
  if (typeof raw !== 'string' || !raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const rules = (parsed as { rules?: unknown })?.rules;
  if (!Array.isArray(rules)) return [];
  const out: StoredMarketplaceFeeRule[] = [];
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const kind = o.kind === 'tiered' ? 'tiered' : o.kind === 'flat' ? 'flat' : null;
    if (!kind) continue;
    out.push({
      clientId: num(o.clientId),
      storeId: num(o.storeId),
      marketplace: normMarketplace(o.marketplace),
      kind,
      percent: num(o.percent),
      threshold: num(o.threshold),
      belowPercent: num(o.belowPercent),
      atOrAbovePercent: num(o.atOrAbovePercent),
      disabled: o.disabled === true,
    });
  }
  return out;
}

/** Map a stored rule to the pure compute shape, filling tiered defaults. */
export function toComputeRule(stored: StoredMarketplaceFeeRule): MarketplaceFeeRule {
  if (stored.kind === 'flat') {
    return { kind: 'flat', percent: stored.percent ?? 0 };
  }
  return {
    kind: 'tiered',
    threshold: stored.threshold ?? DEFAULT_THRESHOLD,
    belowPercent: stored.belowPercent ?? DEFAULT_BELOW_PERCENT,
    atOrAbovePercent: stored.atOrAbovePercent ?? DEFAULT_AT_OR_ABOVE_PERCENT,
  };
}

/**
 * Resolve the most-specific matching rule for a row, or null when none match.
 * A rule matches when each of its set scopes equals the row's. Specificity:
 * storeId (4) > clientId (2) > marketplace (1); highest score wins, first on ties.
 * Store-scopability is required (e.g. KF Goods spans an amazon + a non-amazon store).
 */
export function resolveStoredMarketplaceFeeRule(
  rules: StoredMarketplaceFeeRule[],
  scope: MarketplaceFeeScope,
): StoredMarketplaceFeeRule | null {
  const scopeMarketplace = normMarketplace(scope.marketplace);
  let best: StoredMarketplaceFeeRule | null = null;
  let bestScore = -1;
  for (const rule of rules) {
    if (rule.disabled) continue;
    if (rule.storeId != null && rule.storeId !== (scope.storeId ?? null)) continue;
    if (rule.clientId != null && rule.clientId !== (scope.clientId ?? null)) continue;
    if (rule.marketplace != null && rule.marketplace !== scopeMarketplace) continue;
    const score =
      (rule.storeId != null ? 4 : 0) +
      (rule.clientId != null ? 2 : 0) +
      (rule.marketplace != null ? 1 : 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

/** Convenience: resolve a row's compute-ready rule (most-specific) or null. */
export function resolveMarketplaceFeeRule(
  rules: StoredMarketplaceFeeRule[],
  scope: MarketplaceFeeScope,
): MarketplaceFeeRule | null {
  const stored = resolveStoredMarketplaceFeeRule(rules, scope);
  return stored ? toComputeRule(stored) : null;
}

/**
 * Product subtotal from an order's items: Σ non-adjustment unitPrice×qty
 * (== SUM(order_items.line_total)). Pre-tax, pre-shipping. Mirrors
 * src/services/order-items.ts line-total derivation.
 */
export function computeProductSubtotal(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const adjustment = item.adjustment;
    const isAdjustment =
      adjustment === true ||
      (typeof adjustment === 'string' && ['true', '1', 'yes'].includes(adjustment.toLowerCase()));
    if (isAdjustment) continue;
    const qty = Math.max(0, num(item.quantity) ?? 0);
    if (qty <= 0) continue;
    const unitPrice = Math.max(0, num(item.unitPrice ?? item.unit_price ?? item.price) ?? 0);
    const explicitLine = num(item.lineTotal ?? item.line_total ?? item.total);
    total += explicitLine != null ? Math.max(0, explicitLine) : unitPrice * qty;
  }
  return roundMoney(total);
}

/** Load the configured rules from the settings KV (empty array on miss/parse fail). */
// 60s TTL cache: re-read from settings on EVERY /orders request before this.
// Writes go through PUT/DELETE /settings/:key, which call
// clearMarketplaceFeeRulesCache(); other instances converge within the TTL.
const MARKETPLACE_FEE_RULES_TTL_MS = 60_000;
let marketplaceFeeRulesCache: { at: number; value: StoredMarketplaceFeeRule[] } | null = null;

export function clearMarketplaceFeeRulesCache(): void {
  marketplaceFeeRulesCache = null;
}

export async function loadMarketplaceFeeRules(): Promise<StoredMarketplaceFeeRule[]> {
  if (marketplaceFeeRulesCache && Date.now() - marketplaceFeeRulesCache.at < MARKETPLACE_FEE_RULES_TTL_MS) {
    return marketplaceFeeRulesCache.value;
  }
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, MARKETPLACE_FEE_RULES_KEY))
      .limit(1);
    const rules = parseMarketplaceFeeRules(row?.value ?? null);
    marketplaceFeeRulesCache = { at: Date.now(), value: rules };
    return rules;
  } catch (err) {
    console.warn('[marketplace-fee] rules lookup skipped:', err instanceof Error ? err.message : err);
    return [];
  }
}
