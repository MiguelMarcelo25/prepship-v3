// Canonical Sales-Performance heatmap deviation / tone policy.
//
// PS-325 (slice 3): the Dashboard heatmap's per-cell baseline, deviation %, and tone banding were
// computed by buildHeatmap()/heatmapTone() DEFINED inside DashboardView — the frontend owned the
// rule for "what counts as a hot/cold cell." This module is the single owner of that policy. Like
// src/lib/kpi-delta (PS-325 slice 2) and src/lib/inventory-stock-status (slice 1), it is pure and
// lives in the backend layer so both backend and frontend import ONE definition that cannot drift.
//
// Scope notes: the COLOR palette (HEATMAP_TONE_HEX) is presentation and stays in DashboardView. This
// deviation is DISTINCT from kpi-delta's relativePct — it is per-SKU per-day-vs-daily-baseline (a
// 3-stage baseline fallback with a unit floor, asymmetric tone bands, and NO +100% growth-from-zero
// floor), so it earns its own owner rather than being folded into relativePct.

// Inlined number/array helpers, copied verbatim from DashboardView so this module is dependency-free
// and the arithmetic is byte-identical to the pre-extraction code.
function num(value: unknown, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function sumValues(values: number[]) {
  return values.reduce((sum, value) => sum + num(value), 0)
}

function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function normalizeSku(value: unknown) {
  return String(value ?? '').trim()
}

export type HeatmapCell = {
  day: string
  qty: number
  // baseline = the average daily units in the prior 30-day window
  // for this SKU. Used both to compute the deviation % and to show
  // "expected vs actual" in the click-to-explain popover.
  baseline: number
  deviation: number
  tone: 'high' | 'mid' | 'flat' | 'dip' | 'low'
}

export type HeatmapRow = {
  label: string
  cells: HeatmapCell[]
}

// Loose structural input that both the frontend SalesPayload and a backend sku-trends payload
// satisfy, so the same owner can be called from either layer.
export type HeatmapSalesInput = {
  dates?: string[]
  series?: Record<string, number[] | undefined>
  topSkus?: Array<{ sku?: unknown; name?: unknown }>
}

export function heatmapTone(deviation: number): HeatmapCell['tone'] {
  if (deviation >= 20) return 'high'
  if (deviation >= 10) return 'mid'
  if (deviation > -10) return 'flat'
  if (deviation > -20) return 'dip'
  return 'low'
}

export function buildHeatmap(current: HeatmapSalesInput, prior: HeatmapSalesInput, limit = 6): HeatmapRow[] {
  // 2026-05-13: switched from "by family" (grouped via
  // productFamily()) to "by individual SKU" per operator request.
  // Each topSku now becomes its own row instead of being merged
  // into a family bucket. The downstream cell-click handler still
  // calls its label field "family" — that's a historical name; the
  // string it carries is now a SKU label, but renaming the type
  // field would ripple into setSelectedHeatmapCell + drawer code
  // for no operator-facing benefit.
  const dates = safeArray<string>(current?.dates)
  const currentSeries = current?.series ?? {}
  const priorSeries = prior?.series ?? {}

  type SkuBucket = {
    label: string
    current: number[]
    prior: number[]
    total: number
  }
  const skuBuckets: SkuBucket[] = []

  for (const sku of safeArray<any>(current?.topSkus)) {
    const key = normalizeSku(sku?.sku)
    if (!key) continue
    // Row label = product name when available, else fall back to
    // the raw SKU code. Operators recognize names faster than codes
    // for active product lines, but the SKU is a useful fallback
    // for unnamed catalog entries.
    const name = String(sku?.name ?? '').trim()
    const label = name || key
    const currentValues = currentSeries[key] ?? []
    const priorValues = priorSeries[key] ?? []
    const bucket: SkuBucket = {
      label,
      current: Array.from({ length: dates.length }, () => 0),
      prior: Array.from({ length: dates.length }, () => 0),
      total: 0,
    }
    for (let index = 0; index < dates.length; index += 1) {
      const currentQty = num(currentValues[index])
      const priorQty = num(priorValues[index])
      // bucket.current/prior are pre-sized to dates.length above, so index is
      // always in range; the compound-assignment read can't take a `!`, so the
      // noUncheckedIndexedAccess "possibly undefined" on the implicit read is
      // suppressed here without any runtime change (PS-257).
      // @ts-ignore TS2532 — index is in-bounds (array pre-sized to dates.length)
      bucket.current[index] += currentQty
      // @ts-ignore TS2532 — index is in-bounds (array pre-sized to dates.length)
      bucket.prior[index] += priorQty
      bucket.total += currentQty
    }
    skuBuckets.push(bucket)
  }

  return skuBuckets
    .sort((a, b) => b.total - a.total)
    .slice(0, Math.max(1, limit))
    .map((bucket) => {
      const baseline = sumValues(bucket.prior) / Math.max(1, bucket.prior.length)
      const fallback = sumValues(bucket.current) / Math.max(1, bucket.current.length) || 1
      const compareTo = baseline > 0 ? baseline : fallback
      return {
        label: bucket.label,
        cells: dates.slice(-15).map((day, offset) => {
          const index = dates.length - 15 + offset
          const qty = num(bucket.current[index])
          const deviation = compareTo > 0 ? ((qty - compareTo) / compareTo) * 100 : 0
          return {
            day,
            qty,
            baseline: compareTo,
            deviation,
            tone: heatmapTone(deviation),
          }
        }),
      }
    })
}
