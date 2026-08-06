// PS-488 AC-1 — canonical owner of a Billing row's VISIBLE reference and type.
//
// Outbound order 1234 renders as `#1234`. Its first return renders as a separate row
// `#1234-RETURN`, additional returns as `#1234-RETURN-2`, `-3`.
//
// The suffix is DISPLAY/SEARCH identity only. Relational ids stay canonical, so nothing
// here may be used as a key, a join, or an idempotency token — PS-487 keys return billing
// on `return:<id>:<kind>` precisely so a display string can change without moving money.
//
// This module does NOT mint the `-RETURN` suffix. The Client Portal generates it at
// return creation and persists it on returns.return_reference, and the numbering depends
// on a count of that order's existing returns. Re-deriving it here would be a second
// generator that cannot see that count: PrepShip would render `-RETURN` for what the
// portal already stored as `-RETURN-2`, and the same return would carry two different
// visible identities on two screens. Render what was stored; refuse when it is absent.

export type BillingRowType = 'Outbound' | 'Return';

export type BillingRowIdentity = {
  /** What the Billing Type column shows. */
  rowType: BillingRowType;
  /** What the reference column shows, `#`-prefixed. Null when unresolvable. */
  displayReference: string | null;
};

/** Strip a leading '#' so a stored value that already carries one is not doubled. */
function bare(value: string): string {
  return value.trim().replace(/^#+/, '').trim();
}

/**
 * Resolve the visible identity of one billing row.
 *
 * A row is a Return when it carries a returnId — the relational fact — not when its
 * reference happens to end in "-RETURN". A string test would misclassify an outbound
 * order whose order number legitimately contains that text.
 */
export function billingRowIdentity(input: {
  orderNumber?: string | null;
  orderId?: number | null;
  returnId?: number | null;
  /** returns.return_reference, as persisted by the Client Portal. */
  returnReference?: string | null;
}): BillingRowIdentity {
  const isReturn = typeof input.returnId === 'number' && Number.isFinite(input.returnId);

  if (isReturn) {
    const stored = typeof input.returnReference === 'string' ? bare(input.returnReference) : '';
    // No stored reference means the portal has not assigned one. Inventing `-RETURN`
    // here could collide with a real `-RETURN-2` that already exists on this order.
    return { rowType: 'Return', displayReference: stored ? `#${stored}` : null };
  }

  const number = typeof input.orderNumber === 'string' ? bare(input.orderNumber) : '';
  if (number) return { rowType: 'Outbound', displayReference: `#${number}` };

  // Fall back to the relational id so a row is never anonymous, but only when it is a
  // real id — `#null` or `#0` would be worse than showing nothing.
  const id = input.orderId;
  if (typeof id === 'number' && Number.isFinite(id) && id > 0) {
    return { rowType: 'Outbound', displayReference: `#${id}` };
  }
  return { rowType: 'Outbound', displayReference: null };
}
