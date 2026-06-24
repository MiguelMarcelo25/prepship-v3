// PS-312 (S0) — PURE bundle-membership invariants. The structural rules every combined-shipment
// bundle must satisfy, independent of the DB. The create/repair writers (S2/S8) validate against
// this before persisting, so a malformed bundle (no primary, two primaries, a lone member, a
// duplicated order) can never be written. No DB, no IO.

export type BundleMemberRole = 'primary' | 'child';

export type BundleMemberInput = {
  orderId: number;
  role: BundleMemberRole;
  status?: string; // defaults to 'active'
};

export type BundleValidation = {
  valid: boolean;
  errors: string[];
};

export function validateBundleMembership(members: BundleMemberInput[]): BundleValidation {
  const errors: string[] = [];
  const active = members.filter((m) => (m.status ?? 'active') === 'active');

  const primaries = active.filter((m) => m.role === 'primary');
  if (primaries.length !== 1) {
    errors.push(`a bundle must have EXACTLY ONE primary member (found ${primaries.length})`);
  }

  if (active.length < 2) {
    errors.push(`a bundle must have AT LEAST 2 active members (found ${active.length})`);
  }

  const orderIds = active.map((m) => m.orderId);
  if (new Set(orderIds).size !== orderIds.length) {
    errors.push('an order may not appear more than once in a bundle');
  }

  return { valid: errors.length === 0, errors };
}

/** The primary order id of a valid bundle (or null if the membership is invalid). */
export function primaryOrderIdOf(members: BundleMemberInput[]): number | null {
  if (!validateBundleMembership(members).valid) return null;
  return members.find((m) => m.role === 'primary' && (m.status ?? 'active') === 'active')?.orderId ?? null;
}
