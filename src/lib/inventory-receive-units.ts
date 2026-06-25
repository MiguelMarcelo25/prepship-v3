// Canonical resolver for the UNIT quantity a receive line writes to the inventory ledger.
//
// PS-324: the pack→unit expansion is a persisted MOVEMENT quantity (backend truth), so it is
// computed from the CANONICAL inventory.units_per_pack — never a client-supplied multiplier.
// The frontend sends a pack-count `packs` intent; a legacy pre-multiplied `qty` is still honored
// for back-compat (the per-id route / external callers). `packs` wins when both are present.

export interface ReceiveLineQuantity {
  packs?: number | null;
  qty?: number | null;
}

// Resolve the unit quantity to persist. `canonicalUnitsPerPack` is the inventory row's
// units_per_pack (defaults to 1 when missing/non-positive). Returns 0 when neither packs nor a
// legacy qty is provided (the caller rejects a non-positive receive).
export function resolveReceiveUnits(
  line: ReceiveLineQuantity,
  canonicalUnitsPerPack: number | null | undefined,
): number {
  const unitsPerPack = Number(canonicalUnitsPerPack) > 0 ? Number(canonicalUnitsPerPack) : 1;
  if (line.packs != null) return line.packs * unitsPerPack;
  return line.qty ?? 0;
}
