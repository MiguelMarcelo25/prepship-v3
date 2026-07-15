/**
 * rates-recalculate-persist.ts — PS-175 (Phase 3, part 2): server-side
 * persistence of the strict-recalculation outcome.
 *
 * Per user override unlock shipped data on 2026-06-12: this writer mirrors the
 * guarded PATCH /orders/:id semantics for the strict-recalculate path — it
 * REFUSES to write unless the order is awaiting_shipment (the same
 * shipped/cancelled lock assertOrderEditable enforces on the routes), reuses
 * the canonical best-rate normalizer + the shipping-service eligibility
 * re-check, and touches order_overrides only (never orders/shipments money
 * columns). Kept separate from rates-recalculate.ts so the DECISION module
 * stays pure/importable by the offline guard.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { orders, orderOverrides } from '../db/schema/orders';
import { normalizeOrderBestRateDto, type OrderBestRateDto } from './order-rate-dto';
import { persistBestRateWithRatchet } from './best-rate-ratchet-db';
import {
  describeShippingService,
  evaluateShippingServiceEligibility,
} from '../lib/shipping-service-eligibility';
import type { StrictRecalculateDecision } from './rates-recalculate';
import { orderShippingEligibilityContext } from './orders-read-model';

export type StrictPersistResult = { persisted: boolean; reason?: string };

export async function persistStrictRecalculateOutcome(input: {
  orderId: number;
  decision: StrictRecalculateDecision;
  /** The finalized browse bestRate (carries quote/key/proof/expiry per PS-105/174/183). */
  bestRate: Record<string, unknown> | null;
  dimsL: number | null;
  dimsW: number | null;
  dimsH: number | null;
  weightOz: number | null;
  rateCount: number;
  fetchedAt: string;
  requestFingerprint: string;
  /**
   * PS-271 (Layer 4 honesty): the route's honest completeness verdict for the COMBINED
   * carrier universe (isBestRateComplete(combinedCarrierStatuses)). A thin-but-accepted
   * strict best (one carrier live, another live-but-thin) plans an `apply` yet is NOT
   * complete — so the persisted rate must record this truth, never a hardcoded true.
   * Optional for back-compat: when omitted, completeness is treated as unproven (false).
   */
  bestRateComplete?: boolean;
}): Promise<StrictPersistResult> {
  if (input.decision.action === 'blocked') {
    return { persisted: false, reason: 'blocked decisions never write' };
  }

  const [order] = await db
    .select({
      id: orders.id,
      orderStatus: orders.orderStatus,
      clientId: orders.clientId,
      storeId: orders.storeId,
      raw: orders.raw,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (!order) return { persisted: false, reason: 'order not found' };
  // Same lock the guarded routes enforce: shipped/cancelled rows are immutable.
  if (order.orderStatus !== 'awaiting_shipment') {
    return { persisted: false, reason: `order is ${order.orderStatus ?? 'not awaiting'} — not editable` };
  }

  const hasDims =
    input.dimsL != null && input.dimsL > 0 &&
    input.dimsW != null && input.dimsW > 0 &&
    input.dimsH != null && input.dimsH > 0;
  const dimsPatch = {
    ...(hasDims ? { rateDimsL: input.dimsL, rateDimsW: input.dimsW, rateDimsH: input.dimsH } : {}),
    ...(input.weightOz != null && input.weightOz > 0 ? { rateWeightOz: input.weightOz } : {}),
  };

  if (input.decision.action === 'clear') {
    await db
      .insert(orderOverrides)
      .values({ orderId: input.orderId, ...dimsPatch, bestRateJson: null, bestRateDims: null, bestRateAt: null, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: orderOverrides.orderId,
        set: { ...dimsPatch, bestRateJson: null, bestRateDims: null, bestRateAt: null, updatedAt: new Date() },
      });
    return { persisted: true };
  }

  // apply
  if (!input.bestRate) return { persisted: false, reason: 'apply decision without a best rate' };
  if (!hasDims) return { persisted: false, reason: 'Complete dimensions are required before saving a best rate' };

  // PS-271 (Layer 4 honesty): record the route's honest completeness verdict, NOT a hardcoded
  // true. A strict-recalc `apply` can win on a thin/unproven pass (status live, but a carrier
  // came back thin) — that best is real and saved, but isComplete must stay false so the Orders/
  // RateBrowser column shows coverage-incomplete instead of a false "complete". The completeness
  // truth is owned upstream by isBestRateComplete(combinedCarrierStatuses) on the route.
  const rateWithMetadata = {
    ...input.bestRate,
    requestFingerprint: input.requestFingerprint,
    cacheKey: input.requestFingerprint,
    cacheCreatedAt: input.fetchedAt,
    isComplete: input.bestRateComplete === true,
    rateCount: input.rateCount,
    matchType: 'strict-live',
  };
  let canonical: OrderBestRateDto | null;
  try {
    canonical = normalizeOrderBestRateDto(rateWithMetadata, 'bestRateJson');
  } catch (err) {
    return { persisted: false, reason: (err as Error).message };
  }
  // Per user override unlock shipped data on 2026-07-15: the awaiting-only
  // writer delegates PO Box eligibility to the canonical order context before persisting.
  const eligibility = evaluateShippingServiceEligibility(
    orderShippingEligibilityContext(order),
    describeShippingService(canonical),
  );
  if (!eligibility.allowed) {
    return { persisted: false, reason: eligibility.reason ?? 'Shipping service is not eligible for this order' };
  }

  // PS-271: no-downgrade ratchet (automated persist site). A thin/flickery Shipp re-quote must not
  // overwrite a CHEAPER fresh best for the SAME shipment inputs (same requestFingerprint); a different
  // fingerprint means the inputs changed -> the prior is stale -> replace it. The operator's
  // deliberate FE PATCH save is a separate path and is exempt.
  const bestRateDims = `${input.dimsL}x${input.dimsW}x${input.dimsH}`;
  const persistedSet = {
    ...dimsPatch,
    selectedPid: input.decision.selectedPid,
    bestRateJson: canonical,
    bestRateDims,
    bestRateAt: new Date(),
    updatedAt: new Date(),
  };
  const persisted = await persistBestRateWithRatchet(input.orderId, persistedSet);
  if (persisted.blocked) {
    return { persisted: false, reason: 'no-downgrade: kept the cheaper fresh best for the same shipment inputs' };
  }
  return { persisted: true };
}
