// Canonical "vs prior period" relative-change definition for the Dashboard KPI deltas.
//
// PS-325 (slice 2): the +X% / -X% chips on the Dashboard KPI cards (Last 7 Days, {range}-Day,
// Total Revenue) and the SKU table's "vs Prior 30 Days" change% column were computed by a
// relativePct() defined INSIDE DashboardView — i.e. the frontend OWNED the rule for what a
// relative change "means" (the +100% growth-from-zero floor, the both-empty 0%, the signed
// formula). This module is the single owner of that definition. Like src/lib/inventory-stock-status
// (slice 1) and src/lib/inventory-reorder-policy (PS-150), it is pure and lives in the backend layer
// so both the backend and the frontend import ONE definition that cannot drift.
//
// Scope note: NaN/Infinity safety, rounding, the "+" sign, and good/bad/flat coloring are
// PRESENTATION and stay in DashboardView (formatPct + ChangeText) — not here. The heatmap
// per-day-vs-daily-baseline deviation is a DISTINCT formula (different edge handling) and is
// intentionally NOT owned by this file.

// Signed relative change of `current` vs `prior`, as a percentage.
//   - both empty (prior <= 0 && current <= 0) -> 0    (no movement)
//   - growth from zero (prior <= 0, current > 0) -> 100   (the +100% floor; prior===0 and prior<0 alike)
//   - otherwise -> ((current - prior) / prior) * 100   (raw signed float; current=0 yields -100)
// The prior <= 0 guard precedes the division, so this never divides by zero.
export function relativePct(current: number, prior: number): number {
  if (prior <= 0 && current <= 0) return 0
  if (prior <= 0) return 100
  return ((current - prior) / prior) * 100
}
