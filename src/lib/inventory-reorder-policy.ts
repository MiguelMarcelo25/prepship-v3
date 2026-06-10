/**
 * PS-150 — Canonical reorder policy (velocity model).
 *
 * Single owner for the inventory restock / days-supply / target-stock math. Ported VERBATIM from the
 * Dashboard SKU table's previous client-side compute (the velocity model DJ selected as canonical on
 * 2026-06-10). Both the frontend (DashboardView) and the backend dashboard `/inventory-risk` route
 * delegate here so the reorder numbers can never drift between layers.
 *
 * Pure math — no DB, no IO — so the web bundle can import it directly via `../../../../src/lib/...`.
 *
 * Velocity model: forecast ~14 days of demand from the trailing 30-day units sold; reorder up to that
 * target (never below the min/par floor), never a negative quantity.
 *
 * NOTE: the reporting-metrics service (which also feeds the InventoryView list) intentionally keeps its
 * own reorder computation — adopting this model there would change InventoryView numbers and is a
 * separate, behavior-changing decision, not part of PS-150's Dashboard scope.
 */
export interface ReorderPolicyInput {
  /** Units sold over the trailing 30 days. */
  units30: number;
  /** Current stock on hand. */
  stock: number;
  /** Minimum / par-stock floor (callers pass `minStock ?? reorderLevel`). */
  minStock: number;
}

export interface ReorderPolicy {
  /** Average units sold per day over the trailing 30 days. */
  velocityPerDay: number;
  /** Days of stock remaining at the current velocity; null when there is no velocity. */
  daysSupply: number | null;
  /** Target stock level: max(minStock, ~14 days of demand). */
  targetStock: number;
  /** Units to reorder to reach the target; never negative. */
  restockQty: number;
}

export function computeReorderPolicy(input: ReorderPolicyInput): ReorderPolicy {
  const velocityPerDay = input.units30 > 0 ? input.units30 / 30 : 0;
  const daysSupply = velocityPerDay > 0 ? input.stock / velocityPerDay : null;
  const targetStock = Math.max(input.minStock, velocityPerDay * 14);
  const restockQty = Math.max(0, Math.ceil(targetStock - input.stock));
  return { velocityPerDay, daysSupply, targetStock, restockQty };
}
