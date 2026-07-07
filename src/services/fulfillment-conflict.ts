export type FulfillmentConflictCode =
  | 'marketplace_fulfilled_local_cancelled'
  | 'marketplace_fulfilled_missing_local_shipment'
  | 'marketplace_tracking_attached_to_other_order'
  | 'upstream_order_missing_after_marketplace_fulfilled';

export type FulfillmentConflictBillingAction = 'shipping_missing_review';

export type FulfillmentConflictInput = {
  orderId?: number | string | null;
  orderNumber?: string | null;
  orderStatus?: string | null;
  canonicalStatus?: string | null;
  effectiveOrderStatus?: string | null;
  orderLifecycleStatus?: string | null;
  sourceProvider?: string | null;
  externallyShipped?: boolean | null;
  externallyFulfilled?: boolean | null;
  externallyFulfilledVerified?: boolean | null;
  externallyShippedSource?: string | null;
  marketplaceFulfillmentStatus?: string | null;
  marketplaceDeliveryStatus?: string | null;
  marketplaceName?: string | null;
  marketplaceTrackingNumber?: string | null;
  hasLocalShipment?: boolean | null;
  upstreamOrderMissing?: boolean | null;
  trackingAttachedOrderId?: number | string | null;
  trackingAttachedOrderNumber?: string | null;
};

export type FulfillmentConflictDto = {
  code: FulfillmentConflictCode;
  codes: FulfillmentConflictCode[];
  label: string;
  reason: string;
  severity: 'warning';
  billingAction: FulfillmentConflictBillingAction | null;
  evidence: string[];
  marketplaceName: string | null;
  trackingCollisionOrderId: number | string | null;
  trackingCollisionOrderNumber: string | null;
};

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled', 'upstream_cancelled']);
const FULFILLED_TERMS = ['fulfilled', 'delivered', 'complete', 'completed'];
const MARKETPLACE_FULFILLED_SOURCES = new Set([
  'marketplace_fulfilled',
  'marketplace-fulfilled',
  'shopify_fulfilled',
  'shopify-fulfilled',
  'store_fulfilled',
  'store-fulfilled',
]);

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizedStatus(value: unknown): string | null {
  return normalizedText(value)?.toLowerCase().replace(/\s+/g, '_') ?? null;
}

function isCancelledLike(...values: unknown[]): boolean {
  return values.some((value) => {
    const normalized = normalizedStatus(value);
    return normalized ? CANCELLED_STATUSES.has(normalized) : false;
  });
}

function statusIndicatesFulfilled(value: unknown): boolean {
  const normalized = normalizedStatus(value);
  if (!normalized) return false;
  return FULFILLED_TERMS.some((term) => normalized.includes(term));
}

export function normalizeFulfillmentTrackingNumber(value: unknown): string | null {
  const text = normalizedText(value);
  if (!text) return null;
  const normalized = text.replace(/\s+/g, '').toUpperCase();
  return normalized || null;
}

export function hasMarketplaceFulfilledEvidence(input: FulfillmentConflictInput): boolean {
  const source = normalizedStatus(input.externallyShippedSource);
  return (
    input.externallyFulfilled === true ||
    input.externallyFulfilledVerified === true ||
    (input.externallyShipped === true && source != null && MARKETPLACE_FULFILLED_SOURCES.has(source)) ||
    (source != null && MARKETPLACE_FULFILLED_SOURCES.has(source)) ||
    statusIndicatesFulfilled(input.marketplaceFulfillmentStatus) ||
    statusIndicatesFulfilled(input.marketplaceDeliveryStatus)
  );
}

function marketplaceName(input: FulfillmentConflictInput): string | null {
  const explicit = normalizedText(input.marketplaceName);
  if (explicit) return explicit;
  const provider = normalizedStatus(input.sourceProvider);
  if (provider === 'shopify') return 'Shopify';
  return null;
}

function displayMarketplace(input: FulfillmentConflictInput): string {
  return marketplaceName(input) ?? 'Marketplace';
}

export function resolveFulfillmentConflict(input: FulfillmentConflictInput): FulfillmentConflictDto | null {
  const hasMarketplaceEvidence = hasMarketplaceFulfilledEvidence(input);
  const cancelled = isCancelledLike(
    input.orderStatus,
    input.canonicalStatus,
    input.effectiveOrderStatus,
    input.orderLifecycleStatus,
  );
  const hasShipment = input.hasLocalShipment === true;
  const hasTrackingCollision =
    normalizeFulfillmentTrackingNumber(input.marketplaceTrackingNumber) != null &&
    input.trackingAttachedOrderId != null &&
    String(input.trackingAttachedOrderId) !== String(input.orderId ?? '');

  const codes: FulfillmentConflictCode[] = [];
  const evidence: string[] = [];

  if (hasMarketplaceEvidence && cancelled) {
    codes.push('marketplace_fulfilled_local_cancelled');
    evidence.push('marketplace/store fulfillment evidence exists while PrepShip status is cancelled');
  }
  if (hasMarketplaceEvidence && cancelled && !hasShipment) {
    codes.push('marketplace_fulfilled_missing_local_shipment');
    evidence.push('no active local shipment row is linked to this order');
  }
  if (hasMarketplaceEvidence && hasTrackingCollision) {
    codes.push('marketplace_tracking_attached_to_other_order');
    evidence.push('marketplace tracking is already attached to a different PrepShip order');
  }
  if (hasMarketplaceEvidence && input.upstreamOrderMissing === true && (cancelled || !hasShipment)) {
    codes.push('upstream_order_missing_after_marketplace_fulfilled');
    evidence.push('ShipStation upstream order is missing while marketplace/store evidence says fulfilled');
  }

  if (!codes.length) return null;
  const code = codes[0]!;

  const label = `Fulfillment conflict / ${displayMarketplace(input)} delivered but PrepShip cancelled`;
  const reason = !hasShipment
    ? `${displayMarketplace(input)} fulfillment evidence exists, but PrepShip has no verified local shipment for this cancelled order.`
    : `${displayMarketplace(input)} fulfillment evidence contradicts the local cancelled lifecycle.`;

  return {
    code,
    codes,
    label,
    reason,
    severity: 'warning',
    billingAction: hasShipment ? null : 'shipping_missing_review',
    evidence,
    marketplaceName: marketplaceName(input),
    trackingCollisionOrderId: hasTrackingCollision ? input.trackingAttachedOrderId ?? null : null,
    trackingCollisionOrderNumber: hasTrackingCollision ? input.trackingAttachedOrderNumber ?? null : null,
  };
}
