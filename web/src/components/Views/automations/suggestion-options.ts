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
/**
 * Label for a store <option>. The stored value is the store id, so the label
 * must distinguish stores, not clients: a client with three stores otherwise
 * renders three identical rows the operator cannot choose between.
 * The store id is appended only when the client name alone is ambiguous.
 */
export function storeOptionLabel(
  store: ClientSuggestionRow,
  allStores: readonly ClientSuggestionRow[],
): string {
  const name = String(store.clientName ?? '').trim() || `Client ${store.clientId}`;
  const sameClientStores = allStores.filter((row) => row.clientId === store.clientId);
  if (sameClientStores.length <= 1) return name;
  return `${name} · Store ${store.storeId}`;
}

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
    .map(([clientId, info]) => {
      const name = info.name || `Client ${clientId}`;
      return {
        // Stored + searchable by id, but the operator reads the name.
        value: String(clientId),
        label: name,
        primaryText: name,
        hint:
          info.stores > 1
            ? `Client ${clientId} · ${info.stores} stores`
            : `Client ${clientId}`,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}
