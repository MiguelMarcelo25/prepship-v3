/**
 * PS-262a (Per user override unlock shipped data on 2026-06-14) — the single owner
 * of a marketplace shipment-confirmation IDENTITY payload.
 *
 * The per-marketplace identity (eBay lineItems/ebayOrderId, Walmart purchaseOrderId/
 * rawOrder, storeAccountId) used to be built ONLY inside labels.ts. Every other
 * confirmation entry point — the direct mark-shipped-externally path, the
 * auto-recovery enqueue, and the outbox worker — passed a near-empty payload, so a
 * direct eBay/Walmart confirmation reached the connector with no line items /
 * purchase-order id and failed non-retryably ("missing line items") — the order
 * flipped to shipped locally but the marketplace was never told.
 *
 * This module derives that identity from the order ONCE. hydrate fills any MISSING
 * identity field on an existing payload — a live-verified value already present
 * always wins. It is a no-op for ShipStation (which relays its own confirmation) and
 * for non-marketplace/manual orders.
 */

export type MarketplaceConfirmationProvider = 'shipstation' | 'walmart' | 'ebay';

export interface OrderConfirmationIdentitySource {
  externalOrderId: string | null;
  raw?: Record<string, any> | null;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function stripProviderPrefix(externalOrderId: string | null | undefined, provider: string): string {
  const text = firstText(externalOrderId);
  const prefix = `${provider}-`;
  return text.toLowerCase().startsWith(prefix) ? text.slice(prefix.length) : '';
}

/** Map any source/provider string to the canonical confirmation provider, or null
 *  for ShipStation/manual/unknown (no direct marketplace identity to build). */
export function normalizeConfirmationProvider(value: unknown): MarketplaceConfirmationProvider | null {
  const text = firstText(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!text) return null;
  if (text.includes('walmart')) return 'walmart';
  if (text.includes('ebay')) return 'ebay';
  return null;
}

/** The per-marketplace IDENTITY fields, derived from the order (raw + externalOrderId).
 *  Available at EVERY entry point (no label/ShipStation context needed). */
export function buildMarketplaceConfirmationIdentity(
  provider: MarketplaceConfirmationProvider,
  order: OrderConfirmationIdentitySource,
): Record<string, unknown> {
  const raw = order.raw ?? {};
  const storeAccountId = firstText(
    raw.accountId, raw.storeAccountId, raw.sourceAccountId, raw.marketplaceAccountId,
  ) || undefined;

  if (provider === 'walmart') {
    return {
      storeAccountId,
      purchaseOrderId: firstText(
        raw.purchaseOrderId, stripProviderPrefix(order.externalOrderId, 'walmart'), raw.orderId, raw.id,
      ) || undefined,
      rawOrder: raw,
    };
  }
  if (provider === 'ebay') {
    return {
      storeAccountId,
      ebayOrderId: firstText(raw.orderId, stripProviderPrefix(order.externalOrderId, 'ebay'), raw.id) || undefined,
      rawOrder: raw,
      lineItems: Array.isArray(raw.lineItems)
        ? raw.lineItems
            .map((line: any) => ({
              lineItemId: firstText(line?.lineItemId, line?.line_item_id),
              quantity: Number(line?.quantity ?? 1) || 1,
            }))
            .filter((line: any) => line.lineItemId)
        : undefined,
    };
  }
  return {};
}

function isEmpty(value: unknown): boolean {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** Fill any MISSING marketplace-identity field on `payload` from the order. A value
 *  already present (e.g. a live-verified one) is never overwritten. No-op for
 *  ShipStation / non-marketplace providers. Returns a new payload object. */
export function hydrateMarketplaceConfirmationPayload(args: {
  provider: MarketplaceConfirmationProvider | string | null | undefined;
  order: OrderConfirmationIdentitySource;
  payload?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...(args.payload ?? {}) };
  const provider =
    typeof args.provider === 'string' ? normalizeConfirmationProvider(args.provider) : args.provider ?? null;
  if (!provider) return payload; // ShipStation / manual / unknown — nothing to hydrate.

  const identity = buildMarketplaceConfirmationIdentity(provider, args.order);
  for (const [key, value] of Object.entries(identity)) {
    if (value !== undefined && isEmpty(payload[key])) payload[key] = value;
  }
  return payload;
}
