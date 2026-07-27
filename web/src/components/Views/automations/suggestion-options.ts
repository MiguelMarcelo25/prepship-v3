/**
 * Builds the Autosuggest option lists used by the automation rule builder.
 *
 * Display-only. The backend catalog decides which fields exist and which
 * operators they accept; these helpers just make the value box easier to fill
 * in than a raw id box.
 */

import type { AutosuggestOption } from "../../Autosuggest";

export type SkuSuggestionRow = {
  sku: string | null;
  name: string | null;
  clientId: number | null;
  imageUrl?: string | null;
};

export type ClientSuggestionRow = {
  storeId: number;
  clientId: number;
  clientName: string;
  active: boolean;
};

/**
 * One option per distinct SKU, carrying the product thumbnail so the operator
 * can confirm they picked the right item. Autosuggest reserves the thumbnail
 * column whenever imageUrl is present (including null), which keeps row
 * heights stable while keyboard-navigating a mixed list.
 */
export function buildSkuOptions(
  rows: readonly SkuSuggestionRow[],
  hint?: string,
): AutosuggestOption[] {
  const bySku = new Map<string, AutosuggestOption>();
  for (const row of rows) {
    const sku = String(row.sku ?? "").trim();
    if (!sku) continue;
    const key = sku.toLowerCase();
    if (bySku.has(key)) continue;
    bySku.set(key, {
      value: sku,
      label: String(row.name ?? ""),
      hint,
      imageUrl: row.imageUrl ?? null,
    });
  }
  return Array.from(bySku.values()).sort((left, right) =>
    left.value.localeCompare(right.value),
  );
}

/**
 * One option per distinct client id. Several stores can belong to the same
 * client, so the store list is collapsed by clientId.
 *
 * The stored value stays the numeric client id, because that is what
 * order.client_id compares against -- the name is only for the operator.
 */
export function buildClientOptions(
  stores: readonly ClientSuggestionRow[],
): AutosuggestOption[] {
  const byClient = new Map<number, { name: string; stores: number }>();
  for (const store of stores) {
    if (!Number.isFinite(store.clientId)) continue;
    const existing = byClient.get(store.clientId);
    if (existing) {
      existing.stores += 1;
      continue;
    }
    byClient.set(store.clientId, {
      name: String(store.clientName ?? "").trim(),
      stores: 1,
    });
  }
  return Array.from(byClient.entries())
    .map(([clientId, info]) => ({
      value: String(clientId),
      label: info.name || `Client ${clientId}`,
      hint: info.stores > 1 ? `${info.stores} stores` : undefined,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}
