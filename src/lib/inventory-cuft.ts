// Canonical per-unit cubic-feet for one inventory SKU.
//
// PS-324: this storage-fee input used to be DEFINED in the frontend
// (web/src/components/Views/inventory-parity.ts `getInventoryCuFt`), making React a
// second source of truth for a billing number. The same formula is what storage line
// items are billed on — src/services/billing.ts computes storage as
// `Σ stock_qty × (cuFtOverride ‖ (length×width×height)/1728) × storageFeePerCuFt`
// (see the storage block around billing.ts ~1283 and the schema note in
// src/db/schema/billing.ts: "cuFtOverride (or default L×W×H/1728)").
//
// Keeping the definition here, and having the inventory read-model/route delegate to it,
// means the cuFt an operator sees in InventoryView can never disagree with the cuFt the
// client is billed for. Pure and side-effect-free (like inventory-reorder-policy /
// inventory-stock-status), so it is safe to share across the route and, as a deploy-skew
// fallback, the frontend.

function toNum(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

// THE definition of per-unit cubic feet: a positive manual override wins; otherwise the
// product L×W×H (inches) divided by 1728 (in³ per ft³); otherwise 0 when dims are missing.
// Mirrors the storage-billing formula verbatim so the two can never drift.
export function cuFtPerUnit(
  cuFtOverride: number | null | undefined,
  length: number | null | undefined,
  width: number | null | undefined,
  height: number | null | undefined,
): number {
  const override = toNum(cuFtOverride)
  if (override > 0) return override
  const l = toNum(length)
  const w = toNum(width)
  const h = toNum(height)
  if (l > 0 && w > 0 && h > 0) return (l * w * h) / 1728
  return 0
}
