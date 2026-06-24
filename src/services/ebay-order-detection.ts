// Backend "is this an eBay-marketplace order?" classifier.
//
// Mirrors the canonical frontend signal web/src/components/Views/orders-items.ts `isEbayOrder`
// (clientName contains "ebay" → marketplace source contains "ebay" → externalOrderId starts "ebay-").
// The eBay Logistics direct carrier (src/connectors/carrier/ebay-shipping.ts) prices a specific eBay
// order, so getDirectCarrierRatesForRateInput gates it to eBay orders. The original gate keyed on
// `sourceProvider === 'ebay'`, but that field records HOW an order SYNCED, not which marketplace it
// belongs to: DR Prepper's eBay orders arrive via ShipStation (sourceProvider = 'shipstation'), so the
// old gate wrongly excluded every one of them. An eBay order is an eBay order regardless of sync path.
export function isEbayMarketplaceOrder(input: {
  clientName?: string | null;
  sourceProvider?: string | null;
  externalOrderId?: string | null;
  raw?: unknown;
}): boolean {
  if (String(input.clientName ?? '').toLowerCase().includes('ebay')) return true;
  const raw = input.raw && typeof input.raw === 'object' ? (input.raw as Record<string, unknown>) : null;
  const source = [
    input.sourceProvider,
    raw?.source_provider,
    raw?.sourceProvider,
    raw?.source,
    raw?.provider,
    raw?.marketplace,
  ]
    .map((value) => String(value ?? '').toLowerCase())
    .join(' ');
  if (source.includes('ebay')) return true;
  return String(input.externalOrderId ?? '').toLowerCase().startsWith('ebay-');
}
