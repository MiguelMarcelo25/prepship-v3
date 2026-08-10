/**
 * PS-497 — the stranded inventory-claim backlog, as a health probe.
 *
 * Extracted from `src/routes/health.ts` so the QUERY can be executed against a real
 * database in a test, not merely read as source text.
 *
 * Why that matters here specifically: the first version of this probe lived inline in the
 * route and its guard asserted the source contained `status = 'review'` and the field names.
 * Hermes defeated that guard by appending `and false` to the predicate — the probe then
 * reported a permanent zero backlog while all ten assertions still passed, because every
 * string they looked for was still present. A guard that reads SQL cannot tell you what the
 * SQL returns. This module exists so the answer can be measured.
 *
 * Takes its executor as an argument rather than importing one, so the same code path runs
 * against the bounded health pool in production and against PGlite in the guard.
 */

/**
 * Minimal shape of a `postgres`-style tagged-template executor.
 *
 * The query takes no parameters, so this deliberately accepts only the template strings —
 * both the production pool and a PGlite-backed test executor satisfy it, and there is no
 * interpolation to get the variance wrong on.
 */
export type ClaimReviewQuery = (
  strings: TemplateStringsArray,
) => Promise<Array<Record<string, unknown>>>;

export type InventoryClaimReviewHealth = {
  /** Total claims sitting in the terminal `review` state that nothing consumes. */
  reviewCount: number;
  /** New arrivals in the last 24h — distinguishes a static backlog from a resuming leak. */
  reviewLast24h: number;
  /** Age of the oldest stranded claim, in days. */
  oldestAgeDays: number;
};

/**
 * Read the backlog.
 *
 * No filtering beyond `status = 'review'`: this is a diagnostic, and narrowing it is how a
 * real backlog gets hidden behind a comfortable number.
 */
export async function readInventoryClaimReviewHealth(
  query: ClaimReviewQuery,
): Promise<InventoryClaimReviewHealth> {
  const rows = await query`
    select
      count(*)::int as review_count,
      count(*) filter (where created_at > now() - interval '24 hours')::int as review_last_24h,
      coalesce(max(extract(epoch from (now() - created_at)) / 86400), 0)::int as oldest_age_days
    from fulfillment_line_claims
    where status = 'review'
  `;
  const summary = rows[0];
  return {
    reviewCount: Number(summary?.review_count ?? 0),
    reviewLast24h: Number(summary?.review_last_24h ?? 0),
    oldestAgeDays: Number(summary?.oldest_age_days ?? 0),
  };
}
