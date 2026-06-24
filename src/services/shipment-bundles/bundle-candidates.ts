// PS-312 (S1) — PURE bundle-candidate detection. Given awaiting orders, group the ones that could
// intentionally ship together: same client/store scope + same normalized ship-to recipient
// identity, AWAITING only (never shipped/cancelled/voided/labelled), and not already bundled. The
// operator still has to opt in (S2) — this only surfaces "N orders can be bundled". No DB, no IO.

export type BundleCandidateOrder = {
  orderId: number;
  orderNumber: string | null;
  clientId: number | null;
  storeId: number | null;
  shipToName: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  shipToPostalCode: string | null;
  orderStatus: string;
  hasActiveLabel: boolean; //   already has a bought/active label → cannot be bundled (use S8 repair)
  existingBundleId: number | null; // already a member of a bundle → excluded
};

export type BundleCandidateGroup = {
  recipientKey: string;
  clientId: number | null;
  storeId: number | null;
  orderIds: number[];
  orderNumbers: string[];
};

// Only AWAITING orders can be bundled up-front; shipped/cancelled/voided rows use the S8 repair path.
const BUNDLEABLE_STATUSES = new Set(['awaiting_shipment']);

const norm = (value: string | null): string => (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Normalized recipient identity used to group same-recipient orders (name + city + state + zip). */
export function normalizeRecipientIdentity(
  order: Pick<BundleCandidateOrder, 'shipToName' | 'shipToCity' | 'shipToState' | 'shipToPostalCode'>,
): string {
  return [norm(order.shipToName), norm(order.shipToCity), norm(order.shipToState), norm(order.shipToPostalCode)].join('|');
}

/** An order is bundleable only if awaiting, unlabelled, not already bundled, and has a recipient. */
export function isBundleEligible(order: BundleCandidateOrder): boolean {
  if (!BUNDLEABLE_STATUSES.has(order.orderStatus)) return false;
  if (order.hasActiveLabel) return false;
  if (order.existingBundleId != null) return false;
  // Must carry SOME ship-to identity — a blank recipient can never be a confident bundle match.
  return normalizeRecipientIdentity(order).replace(/\|/g, '').length > 0;
}

/**
 * Group eligible orders into bundle candidates. A candidate is a set of 2+ eligible orders sharing
 * the SAME client + store + normalized recipient identity. Single eligible orders are not candidates.
 */
export function findBundleCandidates(orders: BundleCandidateOrder[]): BundleCandidateGroup[] {
  const groups = new Map<string, BundleCandidateGroup>();
  for (const order of orders) {
    if (!isBundleEligible(order)) continue;
    const recipientKey = normalizeRecipientIdentity(order);
    const scopeKey = `${order.clientId ?? 'null'}:${order.storeId ?? 'null'}:${recipientKey}`;
    let group = groups.get(scopeKey);
    if (!group) {
      group = { recipientKey, clientId: order.clientId, storeId: order.storeId, orderIds: [], orderNumbers: [] };
      groups.set(scopeKey, group);
    }
    group.orderIds.push(order.orderId);
    if (order.orderNumber) group.orderNumbers.push(order.orderNumber);
  }
  return [...groups.values()].filter((group) => group.orderIds.length >= 2);
}
