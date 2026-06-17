// PS-220 (P7, slice 4b) — the order ROW's house "marked" amount.
//
// On a SHIPP house order DRP pays the SHIPP rate (drp_cost) but bills the cheapest
// eligible non-SHIPP rate (customer_rate); the spread is DRP's margin. The bold
// "marked" amount the row shows IS that customer_rate. Where it comes from depends
// on the row's lifecycle:
//   - AWAITING: the PROJECTED stamp written at best-rate SAVE — best_rate_json
//     .nextBestNonHouseRate.totalCost (rates.ts P3). No DB read at list time.
//   - SHIPPED:  the REALIZED capture written at label purchase — the sidecar
//     order_competitive_rate.customer_rate (labels.ts P5).
//
// Returns null when neither source yields a positive amount — i.e. this is NOT a
// house row, so the money-tuple owner (buildOrderRowMoneyDisplay) falls through to
// the normal carrier-markup branch. Pure; no imports (offline guard-importable).
export function houseMarkedAmountForRow(input: {
  isAwaiting: boolean;
  projectedNextBestTotalCost: number | null | undefined;
  realizedCustomerRate: number | null | undefined;
}): number | null {
  const value = input.isAwaiting ? input.projectedNextBestTotalCost : input.realizedCustomerRate;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
