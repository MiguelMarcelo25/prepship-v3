// PS-312/PS-317 (S7) — PURE bundle marketplace-confirmation policy: the single source of truth for
// "confirm shipment PER CHILD using the bundle's SHARED tracking." A bundle ships under ONE label,
// but every member order is a separate marketplace order that must be confirmed to ITS marketplace
// — each with the SAME shared tracking/carrier so all children show as shipped (not "no tracking").
// This decides the per-order confirmation intents; the live enqueueShipmentConfirmation +
// processFulfillmentOutboxOnce owners perform the actual outbox enqueue/send, behind a default-OFF
// flag + DJ canary. No DB, no IO, no external send.
import type { BundleRowDto } from './bundle-read-model.js';

export type BundleConfirmationIntent = {
  orderId: number;
  trackingNumber: string;
  carrierCode: string | null;
};

export type BundleConfirmationPlan = {
  // One confirmation intent per member not yet confirmed — each carrying the SHARED tracking.
  intents: BundleConfirmationIntent[];
  // Members skipped because they were already confirmed (idempotency proof).
  skippedAlreadyConfirmed: number[];
  // Why nothing is confirmable yet, when applicable.
  reason: string | null;
};

/**
 * Plan the per-member marketplace confirmations for a bundle. Nothing confirms until the bundle is
 * labeled AND carries a shared tracking number; then every member not already confirmed gets ONE
 * intent stamped with the bundle's shared tracking + carrier. Deterministic + idempotent: a member
 * in `alreadyConfirmedOrderIds` is skipped, so re-running never double-confirms a marketplace.
 */
export function planBundleShipmentConfirmations(
  bundle: BundleRowDto,
  alreadyConfirmedOrderIds: Iterable<number> = [],
): BundleConfirmationPlan {
  if (bundle.status === 'draft') {
    return { intents: [], skippedAlreadyConfirmed: [], reason: 'bundle-not-labeled' };
  }
  const tracking = bundle.trackingNumber;
  if (!tracking) {
    return { intents: [], skippedAlreadyConfirmed: [], reason: 'no-shared-tracking' };
  }
  const already = new Set(alreadyConfirmedOrderIds);
  const intents: BundleConfirmationIntent[] = [];
  const skippedAlreadyConfirmed: number[] = [];
  for (const orderId of bundle.memberOrderIds) {
    if (already.has(orderId)) {
      skippedAlreadyConfirmed.push(orderId);
    } else {
      intents.push({ orderId, trackingNumber: tracking, carrierCode: bundle.carrierCode });
    }
  }
  return { intents, skippedAlreadyConfirmed, reason: null };
}
