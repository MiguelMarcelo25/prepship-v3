/**
 * PS-291 — New Order modal rate-preview row helpers.
 *
 * Two FE-only display/filter concerns for the manual-order rate preview:
 *
 *  1. EXCLUDE marketplace-owned providers. eBay/Walmart "shipping" providers
 *     can only be quoted/purchased against a real marketplace order id (the
 *     marketplace owns the rate + label lifecycle). A manual order created in
 *     the New Order modal has no such id, so those rows are meaningless here
 *     and must be dropped from the preview. This is a presentation filter only
 *     — the backend rate quoter (src/services/rates.ts) remains the source of
 *     truth for what can actually be quoted/purchased; we never recompute a
 *     price or insurance verdict.
 *
 *  2. The account nickname for display is sourced verbatim from the backend
 *     rate's `carrierNickname` (the same field the Rate Browser shows). This
 *     module does not invent or reformat nicknames.
 */

/**
 * Canonical marketplace-owned provider keys that require a real marketplace
 * order id and therefore can't be previewed for an unsaved manual order.
 * Mirrors the Rate Browser provider vocabulary (ebay_shipping / walmart_shipping).
 */
export const MARKETPLACE_OWNED_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  'ebay_shipping',
  'walmart_shipping',
]);

/** Normalize a provider/carrier code to the lookup key shape (lower_snake). */
function normalizeProviderKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * True when the carrier/provider code is a marketplace-owned provider that
 * needs a marketplace order id — exclude these from the manual rate preview.
 */
export function isMarketplaceOwnedProvider(carrierCode: unknown): boolean {
  return MARKETPLACE_OWNED_PROVIDER_KEYS.has(normalizeProviderKey(carrierCode));
}

/**
 * Drop marketplace-owned provider rows from a preview row list. Pure: returns
 * a new array, never mutates the input.
 */
export function excludeMarketplaceOwnedRows<T extends { carrierCode?: unknown }>(
  rows: readonly T[],
): T[] {
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => !isMarketplaceOwnedProvider(row?.carrierCode),
  );
}
