// PS-312/PS-317 (S5) — PURE bundle billing-treatment policy: the single source of truth for "who
// pays shipping + box in a combined-shipment bundle." Shipping/box is billed ONCE, on the bundle
// PRIMARY (it carries the one real label); each CHILD is suppressed and shown as
// "Included — bundled with #<primary>". The live billing pipeline (generateLineItems) delegates to
// this decision behind a default-OFF flag — it does NOT re-derive the rule. No DB, no IO, no money
// math; this only decides the TREATMENT (bill vs. include), never an amount.
import type { BundleRowDto } from './bundle-read-model.js';

export type BundleBillingTreatment =
  // Not bundled, or the bundle primary → bill shipping + box exactly as usual.
  | { kind: 'bill-normally' }
  // A bundle child → suppress its shipping + box lines; surface the "Included — bundled with #N" note.
  | { kind: 'included-in-bundle'; bundleId: number; primaryOrderId: number; note: string };

/**
 * Decide how an order's shipping/box should be billed given its bundle membership (or null when it
 * isn't bundled). The primary and non-bundled orders bill normally; only a child is "included".
 * Defensive: if the DTO is somehow self-referential (role child but primaryOrderId === orderId),
 * fall back to bill-normally so we can never suppress an order that IS the primary.
 */
export function decideBundleBillingTreatment(
  orderId: number,
  bundle: BundleRowDto | null,
): BundleBillingTreatment {
  if (!bundle) return { kind: 'bill-normally' };
  if (bundle.role === 'primary' || bundle.primaryOrderId === orderId) return { kind: 'bill-normally' };
  return {
    kind: 'included-in-bundle',
    bundleId: bundle.bundleId,
    primaryOrderId: bundle.primaryOrderId,
    note: `Included — bundled with #${bundle.primaryOrderId}`,
  };
}

/** Convenience for the billing pipeline: should this order's shipping + box lines be suppressed? */
export function shouldSuppressShippingAndBox(orderId: number, bundle: BundleRowDto | null): boolean {
  return decideBundleBillingTreatment(orderId, bundle).kind === 'included-in-bundle';
}
