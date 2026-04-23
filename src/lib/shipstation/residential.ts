import { ssV1Request } from './v1-client';

// v2-parity port from
// apps/api/src/modules/orders/data/shipstation-residential-gateway.ts.
// Looks up residential address flag for orders that don't already have one
// set so rate shopping picks residential-vs-commercial pricing correctly.
// Uses the V1 /orders endpoint (first page only) with a strict 5s timeout —
// residential classification isn't worth blocking an order response on.

export type ResidentialLookupInput = {
  orderId: number;
  orderNumber: string | null;
};

export type ResidentialLookupResult = {
  orderId: number;
  residential: boolean | null;
};

/**
 * Look up residential flag for a batch of orders via ShipStation V1.
 * Uses the main-account V1 credentials (env.SHIPSTATION_API_KEY/SECRET)
 * because this is a platform-wide classification, not a per-client call.
 *
 * Returns residential=null for any order we can't determine from the
 * ShipStation response (not in first page, no shipTo.residential, timeout,
 * auth error). Callers should fall back to their own heuristic (e.g.
 * company-name based) when residential is null.
 */
export async function lookupResidential(
  items: ResidentialLookupInput[],
): Promise<ResidentialLookupResult[]> {
  if (!items.length) return [];

  // Initialize all-null. We'll fill in positive hits from the SS response.
  const results = new Map<number, boolean | null>(
    items.map((it) => [it.orderId, null] as const),
  );

  // Map ShipStation order number → our internal id for fast matching.
  const byOrderNumber = new Map<string, number>();
  for (const it of items) {
    if (it.orderNumber) byOrderNumber.set(it.orderNumber, it.orderId);
  }
  if (byOrderNumber.size === 0) {
    return [...results].map(([orderId, residential]) => ({ orderId, residential }));
  }

  try {
    // v2-parity: only fetch the first page (pageSize=100) with a 5s timeout.
    // This is best-effort enrichment — we don't want to chase pagination
    // here. ssV1Request's default retry on 5xx still applies.
    const payload = await ssV1Request<{ orders?: Array<Record<string, unknown>> }>(
      '/orders?pageSize=100&page=1',
      { timeoutMs: 5_000, maxRetries: 1, dedupeKey: 'residential:orders:page1' },
    );
    const orders = Array.isArray(payload?.orders) ? payload.orders : [];
    for (const ssOrder of orders) {
      const ssOrderNumber = typeof ssOrder.orderNumber === 'string' ? ssOrder.orderNumber : null;
      if (!ssOrderNumber) continue;
      const ourOrderId = byOrderNumber.get(ssOrderNumber);
      if (ourOrderId === undefined) continue;
      const shipTo = ssOrder.shipTo as Record<string, unknown> | undefined;
      const flag = shipTo?.residential;
      if (typeof flag === 'boolean') {
        results.set(ourOrderId, flag);
      }
    }
  } catch (err) {
    // Swallow — residential is best-effort. Return null for everything so
    // callers fall back to their own heuristic.
    console.warn(
      `[ss-residential] lookup failed (fallback to null for ${items.length} orders):`,
      err instanceof Error ? err.message : err,
    );
  }

  return [...results].map(([orderId, residential]) => ({ orderId, residential }));
}
