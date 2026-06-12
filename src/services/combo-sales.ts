/**
 * PS-213 — multi-SKU combination sales aggregation (pure, DB-free).
 *
 * The Dashboard "Combos" tab answers "which SKU combinations sell TOGETHER"
 * — a different question from Top SKUs (single-SKU unit volume). One order
 * containing 2× SKU-A + 1× SKU-B contributes exactly ONE sale to the combo
 * "sku-a:2|sku-b:1" (comboSales = ORDER count, per the card).
 *
 * Normalization is NOT re-implemented here: the PS-037 combo owner
 * (src/lib/package-combo.ts) defines how raw lines collapse into a
 * deterministic combination — case-insensitive SKU, whitespace trim,
 * duplicate-line qty summing, sorted by SKU (so A+B ≡ B+A), qty part of the
 * key (A:2|B:1 ≠ A:1|B:1). Single-SKU orders are excluded by the same
 * owner's isMultiSkuCombo — they are the Top SKUs story, not a combination.
 */
import {
  computeComboKey,
  isMultiSkuCombo,
  normalizeComboItems,
} from '../lib/package-combo';

export type ComboSalesItemRow = {
  orderId: number;
  sku: string;
  quantity: number;
  unitPrice?: number | string | null;
  name?: string | null;
};

export type ComboSalesEntry = {
  comboKey: string;
  /** Normalized, sorted combination lines with a display name per SKU. */
  items: Array<{ sku: string; qty: number; name: string | null }>;
  skuCount: number;
  /** ORDER count — the card's comboSales definition. */
  comboSales: number;
  /** Total units across all orders of this combo. */
  units: number;
  /** Summed line revenue; null when the caller cannot view financials. */
  revenue: number | null;
};

export type ComboSalesResult = {
  combos: ComboSalesEntry[];
  /** Distinct combos BEFORE the limit — so the UI can be honest about truncation. */
  totalCombos: number;
  /** Orders that formed a multi-SKU combo in the window. */
  multiSkuOrders: number;
};

function toNumber(value: unknown): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function aggregateOrderComboSales(
  rows: ReadonlyArray<ComboSalesItemRow>,
  opts: { limit?: number; includeRevenue?: boolean } = {},
): ComboSalesResult {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 50));
  const includeRevenue = opts.includeRevenue !== false;

  const byOrder = new Map<number, ComboSalesItemRow[]>();
  for (const row of rows) {
    if (!row || !Number.isFinite(row.orderId)) continue;
    const list = byOrder.get(row.orderId);
    if (list) list.push(row);
    else byOrder.set(row.orderId, [row]);
  }

  type Bucket = {
    comboKey: string;
    items: Array<{ sku: string; qty: number }>;
    names: Map<string, string>;
    comboSales: number;
    units: number;
    revenue: number;
  };
  const buckets = new Map<string, Bucket>();
  let multiSkuOrders = 0;

  for (const orderRows of byOrder.values()) {
    // The PS-037 owner decides what the combination IS — including dropping
    // orders that collapse to a single normalized SKU.
    if (!isMultiSkuCombo(orderRows)) continue;
    const items = normalizeComboItems(orderRows);
    const comboKey = computeComboKey(orderRows);
    if (!comboKey) continue;
    multiSkuOrders += 1;

    let bucket = buckets.get(comboKey);
    if (!bucket) {
      bucket = { comboKey, items, names: new Map(), comboSales: 0, units: 0, revenue: 0 };
      buckets.set(comboKey, bucket);
    }
    bucket.comboSales += 1;
    bucket.units += items.reduce((sum, item) => sum + item.qty, 0);
    for (const row of orderRows) {
      const sku = String(row.sku ?? '').trim().toLowerCase();
      if (!sku) continue;
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      // Keep the LONGEST observed product name per SKU (same convention as
      // the Top SKUs SQL: array_agg(name order by length(name) desc)).
      if (name && name.length > (bucket.names.get(sku)?.length ?? 0)) {
        bucket.names.set(sku, name);
      }
      bucket.revenue += toNumber(row.unitPrice) * Math.max(0, toNumber(row.quantity));
    }
  }

  const sorted = [...buckets.values()].sort((a, b) =>
    b.comboSales - a.comboSales || b.units - a.units || (a.comboKey < b.comboKey ? -1 : 1),
  );

  return {
    combos: sorted.slice(0, limit).map((bucket) => ({
      comboKey: bucket.comboKey,
      items: bucket.items.map((item) => ({
        sku: item.sku,
        qty: item.qty,
        name: bucket.names.get(item.sku) ?? null,
      })),
      skuCount: bucket.items.length,
      comboSales: bucket.comboSales,
      units: bucket.units,
      revenue: includeRevenue ? Number(bucket.revenue.toFixed(2)) : null,
    })),
    totalCombos: buckets.size,
    multiSkuOrders,
  };
}
