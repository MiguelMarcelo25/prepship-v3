// Canonical direction invariant for manual inventory movements.
//
// PS-324: which way a movement type moves stock is a BUSINESS rule, not a frontend default.
// InventoryView only *defaulted* a damage entry to "− Remove" (the operator could still flip
// the direction), so the backend accepted a nonsensical positive "damage" that would silently
// INFLATE stock. ship / pick / damage can only REMOVE stock; a manual `adjust` is a free
// correction and receive/return add stock. The canonical movement service and
// DB insert trigger both assert this, so every caller shares the same rule.

export type InventoryMovementType = 'receive' | 'adjust' | 'pick' | 'ship' | 'return' | 'damage';

// Movement types that physically remove stock and therefore require a negative quantity.
const DECREMENT_ONLY = new Set<InventoryMovementType>(['ship', 'pick', 'damage']);
const INCREMENT_ONLY = new Set<InventoryMovementType>(['receive', 'return']);

// Returns a human-readable error when the quantity's sign contradicts the movement type,
// or null when the movement is allowed.
export function movementDirectionError(type: InventoryMovementType, qty: number): string | null {
  if (DECREMENT_ONLY.has(type) && qty >= 0) {
    return `A "${type}" movement must remove stock — use a negative quantity.`;
  }
  if (INCREMENT_ONLY.has(type) && qty <= 0) {
    return `A "${type}" movement must add stock; use a positive quantity.`;
  }
  return null;
}
