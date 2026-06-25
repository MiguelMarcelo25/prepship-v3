// Awaiting Best Rate — DISPLAY-freshness window.
//
// Separate from CACHE_TTL_MS (the 24h purchase-proof TTL in rates.ts). That TTL governs how long a
// saved rate stays PURCHASABLE; this shorter window governs how long it stays TRUSTWORTHY TO DISPLAY
// before the system re-quotes the carrier to DETECT price drift. A saved best rate older than this is
// not invalid — it is "due for a re-check": the passive rater / backfill re-quote it LIVE, and the
// no-downgrade ratchet records the result (a genuine COMPLETE increase overwrites; a thin re-quote is
// still rejected). Default 3h, floor 30m, env-tunable + instantly reversible (unset = 3h).
//
// Lives in its own tiny module (imports nothing) so the workflow DTO (the verdict owner) can import it
// with zero risk of an import cycle through rates.ts. Today only best-rate-workflow-dto.ts consumes it
// (to compute needsDisplayRefresh); the force-live re-rate it triggers runs through the existing
// maxAgeHours:0 backfill path, which does not need the window itself.
export const RATE_DISPLAY_FRESH_MS = Math.max(
  30 * 60 * 1000,
  (Number.parseInt(process.env.RATE_DISPLAY_FRESH_HOURS ?? '3', 10) || 3) * 3_600_000,
);
