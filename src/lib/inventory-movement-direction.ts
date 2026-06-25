// Canonical direction invariant for manual inventory movements.
//
// PS-324: which way a movement type moves stock is a BUSINESS rule, not a frontend default.
// InventoryView only *defaulted* a damage entry to "− Remove" (the operator could still flip
// the direction), so the backend accepted a nonsensical positive "damage" that would silently
// INFLATE stock. ship / pick / damage can only REMOVE stock; a manual `adjust` is a free
// correction and receive/return keep their own endpoints' rules. The adjust routes assert this
// so a buggy or hostile client can't persist a movement whose sign contradicts its type.
//
// Enforced at the manual adjust ROUTES only — never inside applyMovement, which is shared with
// the lockdown-governed fulfillment ship-deduction path and must stay untouched.

export type InventoryMovementType = 'receive' | 'adjust' | 'pick' | 'ship' | 'return' | 'damage';

// Movement types that physically remove stock and therefore require a negative quantity.
const DECREMENT_ONLY = new Set<InventoryMovementType>(['ship', 'pick', 'damage']);

// Returns a human-readable error when the quantity's sign contradicts the movement type,
// or null when the movement is allowed.
export function movementDirectionError(type: InventoryMovementType, qty: number): string | null {
  if (DECREMENT_ONLY.has(type) && qty >= 0) {
    return `A "${type}" movement must remove stock — use a negative quantity.`;
  }
  return null;
}
