// PS-037 — Deterministic SKU+qty combination key for client package defaults.
//
// This is the SOURCE OF TRUTH for how a multi-SKU order maps to a reusable
// package default. The backend derives the key from real order items so the
// frontend never has to be trusted with key computation (req: "do not trust
// only frontend-computed keys"). Keep this pure + dependency-free so it can be
// unit-tested in isolation and reused by services/routes.
//
// Normalization rules (PS-037 §1 / return §4):
//   - SKU normalized case-insensitively and whitespace-trimmed.
//   - Duplicate line items for the same SKU are summed into one total qty.
//   - Lines are sorted by normalized SKU so line ordering never matters.
//   - Quantity is part of the key (Booster x1 + Leeds x1 ≠ Booster x2 + Leeds x1).
//   - Adjustment lines and non-positive quantities are excluded.
//   - Qty is coerced to a positive integer (rounded), matching how the rest of
//     the app treats order line quantities (see fulfillment-deductions).

export interface ComboItemInput {
  sku?: unknown;
  quantity?: unknown;
  qty?: unknown;
  adjustment?: unknown;
}

export interface NormalizedComboItem {
  sku: string;
  qty: number;
}

function normalizeSku(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

function normalizeQty(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  // Match fulfillment-deductions: round to a positive integer, min 1.
  return Math.max(1, Math.round(parsed));
}

/**
 * Collapse raw order items into a sorted, deduped, normalized combination.
 * Returns [] when there are no valid (non-adjustment, positive-qty, has-sku)
 * items — callers should treat that as "no combo default applicable".
 */
export function normalizeComboItems(items: ReadonlyArray<ComboItemInput> | null | undefined): NormalizedComboItem[] {
  if (!Array.isArray(items)) return [];
  const bySku = new Map<string, number>();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    if ((raw as ComboItemInput).adjustment === true) continue;
    const sku = normalizeSku((raw as ComboItemInput).sku);
    if (!sku) continue;
    const qtySource = (raw as ComboItemInput).quantity ?? (raw as ComboItemInput).qty;
    const qty = normalizeQty(qtySource);
    if (qty <= 0) continue;
    bySku.set(sku, (bySku.get(sku) ?? 0) + qty);
  }
  return [...bySku.entries()]
    .map(([sku, qty]) => ({ sku, qty }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

/**
 * Deterministic combo key, e.g. "booster-gel-001:2|hu-10:1".
 * Empty string when no valid items (no default should be saved/looked up).
 */
export function computeComboKey(items: ReadonlyArray<ComboItemInput> | null | undefined): string {
  return normalizeComboItems(items)
    .map((item) => `${item.sku}:${item.qty}`)
    .join('|');
}

/** True when the order has a multi-SKU combination (≥2 distinct SKUs). */
export function isMultiSkuCombo(items: ReadonlyArray<ComboItemInput> | null | undefined): boolean {
  return normalizeComboItems(items).length >= 2;
}
