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

/**
 * Billing line types the return workflow owns.
 *
 * These MUST match what the Client Portal reads, because both applications share one
 * `billing_line_items` table. The portal's invoice read-model sums exactly
 * `return_postage` and `return_processing_fee`, and its customer-shipping-rate rules key
 * off `return_postage` for historical rows — so those names are the established canonical
 * ones and this side is the side that has to match.
 *
 * They were originally written here as 'return_processing' / 'return_label'. Nothing had
 * billed yet, so no rows carry the wrong names, but had a return billed the portal would
 * have summed both to $0.00: PrepShip showing the charge and the client's invoice showing
 * nothing. Two names for one fact in one table is not a naming preference, it is a
 * divergence that only appears as missing money.
 */
export const RETURN_PROCESSING_LINE_TYPE = 'return_processing_fee';
export const RETURN_SHIPPING_LINE_TYPE = 'return_postage';

/**
 * PS-488 M2 — the canonical WRITE vocabulary, and the boundary around it.
 *
 * A new return billing row may carry ONLY these two types, and only with a non-null
 * relational `return_id`. That pairing is the whole point: `line_type` says what the
 * charge is, `return_id` says which return produced it. Migration 0092 enforces both
 * halves in PostgreSQL — a CHECK restricting a non-null `return_id` to these types,
 * and a partial UNIQUE on `(return_id, line_type)` so one return cannot accumulate
 * two postage rows.
 *
 * Kept as an exported set rather than a comment so the writer guard can assert
 * against the owner instead of re-listing the vocabulary somewhere else. Two lists
 * of the same fact is how the original `return_processing` / `return_label`
 * divergence happened.
 */
export const CANONICAL_RETURN_WRITE_LINE_TYPES = [
  RETURN_SHIPPING_LINE_TYPE,
  RETURN_PROCESSING_LINE_TYPE,
] as const;

/**
 * PS-488 M2 — frozen legacy types. READ-ONLY, permanently.
 *
 * Historical rows carry these and are never rewritten merely to rename them; a
 * frozen invoice is financial history. Readers must keep classifying them — the
 * cancelled-order guard, the detail read model and the invoice aggregates all
 * depend on it, and deleting those reads would silently drop real charges from
 * historical invoices.
 *
 * What must never happen is one of these appearing on a NEW write. That is what
 * turns a compatibility alias into a second policy owner.
 */
export const LEGACY_RETURN_READ_ONLY_LINE_TYPES = [
  'return',
  'return_label',
  'return_processing',
] as const;

/**
 * PS-488 M2 — every line type that carries RETURN money, canonical or frozen.
 *
 * This is the set an unrelated owner must never destroy. "Frozen/read-only" means no
 * new writes; it does not make an existing row disposable. A legacy row without
 * relational identity still carries real historical return money, and nothing would
 * put it back: outbound regeneration does not recreate return lines, the canonical
 * writer never emits legacy aliases, the disabled flag stops the return pass
 * entirely, and pre-cutover policy permanently excludes old returns from rebuild.
 *
 * Legacy cleanup or conversion belongs in a separately reviewed reconciliation, never
 * as collateral damage from outbound regeneration.
 */
export const ALL_GOVERNED_RETURN_LINE_TYPES = [
  ...CANONICAL_RETURN_WRITE_LINE_TYPES,
  ...LEGACY_RETURN_READ_ONLY_LINE_TYPES,
] as const;

export type CanonicalReturnWriteLineType = (typeof CANONICAL_RETURN_WRITE_LINE_TYPES)[number];

/** True only for a type a new write may emit. Legacy aliases return false. */
export function isCanonicalReturnWriteLineType(value: unknown): value is CanonicalReturnWriteLineType {
  return (CANONICAL_RETURN_WRITE_LINE_TYPES as readonly unknown[]).includes(value);
}

/**
 * Forward-only cutover. DJ's decision, 2026-08-05: the returns that pre-date PS-487 are
 * NOT billed retroactively.
 *
 * At the time of the decision production held 8 returns (client 4, 2026-07-06..20)
 * carrying ~$30 of captured customer return shipping and no billing lines at all. Once
 * the generator goes live it would otherwise sweep them up and post an unexpected
 * backdated charge to a real client's July invoice. A return created strictly BEFORE
 * this day is permanently out of scope.
 *
 * This is deliberately a hard constant rather than an env flag or a "first run" marker:
 * a flag can be flipped by accident and a marker drifts if the generator is re-run, and
 * either mistake bills a customer for work already invoiced.
 */
export const RETURN_BILLING_CUTOVER_DAY = '2026-08-05';

/**
 * Is this return within the forward-only billing window?
 *
 * Separate from eligibility so the reason a return is skipped stays legible — "before
 * the cutover" is a policy decision, not missing data, and callers/reporting should be
 * able to tell those apart.
 */
export function isReturnWithinBillingCutover(input: {
  createdAt: unknown;
  /** Override only for tests; production always uses the constant. */
  cutoverDay?: string;
}): boolean {
  const created = toIsoDay(input.createdAt);
  if (!created) return false;
  const cutover = input.cutoverDay ?? RETURN_BILLING_CUTOVER_DAY;
  return created >= cutover;
}

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
  /** Override only for tests; production always uses the constant. */
  cutoverDay?: string;
}): boolean {
  if (input.returnId == null || input.returnId === '') return false;
  if (input.clientId == null || input.clientId === '') return false;
  if (toIsoDay(input.createdAt) == null) return false;
  // Forward-only: pre-cutover returns are never billed (DJ, 2026-08-05).
  return isReturnWithinBillingCutover({
    createdAt: input.createdAt,
    cutoverDay: input.cutoverDay,
  });
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
