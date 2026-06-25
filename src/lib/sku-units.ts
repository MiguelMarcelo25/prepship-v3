// Canonical per-SKU unit summing for the Dashboard sku-trends panel.
//
// PS-325 (slice 3b): the Dashboard's per-SKU units30/units7/priorUnits30 (source-1 of the 3-source
// merge) were computed by the FRONTEND re-summing the /dashboard/sku-trends daily series. This module
// is the single owner of that summation. Like slices 1-4 (inventory-stock-status, kpi-delta,
// sales-heatmap-deviation, analytics-provenance) it is pure and shared: the /dashboard/sku-trends
// route emits per-SKU units computed via these fns over the days matrix it returns, and the frontend
// PREFERS the emitted value, falling back to these SAME fns over the series during deploy skew — so
// the displayed numbers are byte-identical.
//
// BYTE-IDENTICAL contract: the coercion is `Number(x) || 0`, matching exactly how the apiClient builds
// the series (`daysArr.map(d => Number(d[sku]) || 0)`). Because the days/series buckets are already
// finite numbers, this equals the frontend's prior sumValues(num(...)). units7 sums the LAST `n` array
// positions (most-recent buckets), mirroring the frontend's last(series, 7). Do NOT reuse the SQL
// total_qty as units30 — it sums the full range WITHOUT the LA-day -> UTC-dateBuckets projection, so it
// is >= the series-sum and would shift numbers on timezone-boundary orders.

// Sum a per-SKU series (an array of per-day quantities) with the byte-identical coercion.
export function sumSkuUnits(values: ReadonlyArray<unknown>): number {
  let total = 0
  for (const value of values) total += Number(value) || 0
  return total
}

// Sum the LAST `n` entries of a per-SKU series (the n most-recent day buckets).
export function sumLastNSkuUnits(values: ReadonlyArray<unknown>, n: number): number {
  return sumSkuUnits(values.slice(Math.max(0, values.length - n)))
}
