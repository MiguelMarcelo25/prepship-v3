// PS-487 slice 1 — the canonical return BILLING EVENT contract.
//
// Pure and offline: decides WHEN a return bills and under WHAT identity. It writes
// nothing. Slice 2 (the generator wiring that actually emits billing lines) consumes
// this; keeping the rules here means the date and the idempotency key have exactly one
// owner, and both are testable without a database.
//
// Verified against production 2026-08-05 before writing this:
//   - `returns` is a first-class shared table (id, order_id, client_id, created_at,
//     requested_at, return_customer_shipping_rate, admin_override*), NOT a shipments row;
//   - 8 real returns exist (client 4, 2026-07-06..20), every one carrying a customer
//     return-shipping rate ($0, $0, $0, 6.77, 6.77, 6.77, 7.95, 8.64);
//   - ZERO billing lines of type return / return_label / return_processing have ever
//     been written. Return billing does not exist yet — this is a build, not a repair.
//   - admin_override has never been used, and requested_at == created_at on all 8.

/** Billing line types the return workflow owns. */
export const RETURN_PROCESSING_LINE_TYPE = 'return_processing';
export const RETURN_SHIPPING_LINE_TYPE = 'return_label';

export type ReturnBillingEventKind =
  | typeof RETURN_PROCESSING_LINE_TYPE
  | typeof RETURN_SHIPPING_LINE_TYPE;

/**
 * AC-3 — the canonical event-date contract.
 *
 * A return bills on its CREATION day, not on any label/shipment date: a return that is
 * started without a label still has to land in the right month (AC-1). An admin may
 * correct that day (AC-4), and the correction wins — but the original system-created
 * timestamp is never overwritten, because AC-7 requires it as audit evidence.
 *
 * Returns null only when there is no usable date at all, so callers must fail closed
 * rather than silently bill "today".
 */
export function resolveReturnBillingEventDate(input: {
  /** returns.created_at — the immutable system-creation timestamp. */
  createdAt: unknown;
  /** Admin-corrected billing day, when one has been set. */
  correctedDate?: unknown;
}): string | null {
  const corrected = toIsoDay(input.correctedDate);
  if (corrected) return corrected;
  return toIsoDay(input.createdAt);
}

/**
 * AC-1 / AC-5 — the idempotency identity.
 *
 * Regeneration must be able to run repeatedly without duplicating a return's charges,
 * and a date correction must MOVE an event rather than mint a second one. So the key is
 * derived from the return and the event kind ONLY — deliberately not the date, or a
 * corrected day would look like a brand-new charge and bill the client twice.
 */
export function returnBillingEventKey(input: {
  returnId: number | string;
  kind: ReturnBillingEventKind;
}): string {
  return `return:${String(input.returnId).trim()}:${input.kind}`;
}

/**
 * AC-1 — is a return eligible for its processing fee yet?
 *
 * True as soon as the return record exists. No shipment, label, tracking number or PDF
 * is required; that is the entire point of the card.
 */
export function isReturnProcessingFeeEligible(input: {
  returnId: unknown;
  clientId: unknown;
  createdAt: unknown;
}): boolean {
  if (input.returnId == null || input.returnId === '') return false;
  if (input.clientId == null || input.clientId === '') return false;
  return toIsoDay(input.createdAt) != null;
}

/**
 * AC-2 — the customer-facing return shipping amount.
 *
 * ONLY returns.return_customer_shipping_rate, the configured customer charge. Raw
 * provider cost and any operator-entered external label cost are rejected outright
 * rather than used as a fallback: a fallback is exactly how an internal cost becomes a
 * customer rate, which is the failure PS-435 already fences on the portal side.
 *
 * Returns null when no customer rate is configured, so the caller bills nothing instead
 * of inventing an amount.
 */
export function resolveReturnCustomerShippingAmount(input: {
  returnCustomerShippingRate: unknown;
}): number | null {
  const value = input.returnCustomerShippingRate;
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** Normalize any accepted timestamp shape to an ISO calendar day (UTC). */
function toIsoDay(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Already a bare calendar day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }
  return null;
}
