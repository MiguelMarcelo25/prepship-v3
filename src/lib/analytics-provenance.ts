// Canonical provenance envelope for the dashboard analytics DTOs.
//
// PS-325 (slice 4): the bare dashboard DTOs (/summary, /daily-counts, ...) returned plain numbers with
// NO disclosure of when they were computed, over what window, or whether the value was served live vs
// from cache. This module is the single owner of the additive `meta` provenance envelope that each
// route stamps. Like src/lib/inventory-stock-status (slice 1) and src/lib/kpi-delta (slice 2), it is
// pure and lives in the backend layer so both the backend route and the frontend import ONE contract.
//
// Invariants:
//   - `computedAt` is the COMPUTE instant, stamped by the route ABOVE the cache read and folded into
//     the payload BEFORE the cache write. Because the analytics cache round-trips the payload verbatim,
//     a cache HIT replays the original instant — so computedAt honestly reports cache age, never the
//     serve-time clock. This module NEVER calls new Date() itself.
//   - `computedAt: null` means client-derived / unknown — missing freshness is LABELED, not fabricated
//     (PS-325). The frontend renders "freshness unknown" rather than the browser wall-clock.

export type DashboardProvenance = {
  computedAt: string | null
  source: 'live' | 'cache'
  window: { from: string; to: string; tz: string }
}

const DEFAULT_TZ = 'America/Los_Angeles'

// Build the live provenance for a freshly-computed payload. The route passes the one-per-request
// `computedAt` it stamped above the cache read; this function does not read the clock.
export function buildProvenance(input: {
  from: string
  to: string
  computedAt: string | null
  tz?: string
}): DashboardProvenance {
  return {
    computedAt: input.computedAt,
    source: 'live',
    window: { from: input.from, to: input.to, tz: input.tz ?? DEFAULT_TZ },
  }
}

// Flip a stored (live) provenance to 'cache' on the cache-hit branch. Preserves computedAt + window,
// so the served value still reports its true compute instant and window.
export function markCached(meta: DashboardProvenance): DashboardProvenance {
  return { ...meta, source: 'cache' }
}
