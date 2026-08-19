import type { ShippingMarginPolicy } from '../house-account-opt-in.js';
import type { OrderBestRateDto } from '../order-rate-dto.js';

/**
 * PS-508 — the house-margin derivation, lifted out of its IO shell.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────────────────
 *
 * These two functions were already pure, but they lived in `house-margin-capture.ts`, whose very
 * first line is `import { sql as pg } from '../../db/client.js'`. Importing that module executes
 * db/client, which validates the database env at MODULE LOAD. Anything that wants to prove the
 * derivation offline therefore had to carry a full database env just to reach a function that
 * touches no database — the exact shape of the PS-502 failure where a pure classifier pulled in
 * db/client and turned a CI lane red for four commits before anyone connected the two.
 *
 * PS-508 makes the ordinary-outbound freeze depend on this derivation, so it acquires a second
 * caller and a guard that must run in a lane with no database. Hence the split.
 *
 * BOTH imports above are `import type` and are erased at compile time. This module must never
 * acquire a value import — that is the entire property it exists to hold.
 *
 * `house-margin-capture.ts` re-exports both functions, so every existing importer (labels.ts and
 * five PS-220/PS-292/PS-295 guards) is unchanged.
 */

export type RealizedHouseMargin = {
  customerRate: number;
  margin: number;
  competitorCount: number;
  sourceCarrier: string | null;
  sourceService: string | null;
  sourceProviderAccountId: number | null;
};

/**
 * Pure: derive the realized house-margin record from the projected best-rate stamp + the actual
 * SHIPP cost paid. Returns null when the order carries no projected house stamp (houseMargin == null)
 * — i.e. it was not captured as a house order (rated before opt-in / not a SHIPP-winning save).
 */
export function houseMarginFromProjection(best: OrderBestRateDto | null, drpCost: number): RealizedHouseMargin | null {
  if (!best || best.houseMargin == null) return null;
  const competitor = best.nextBestNonHouseRate;
  const customerRate = competitor ? competitor.totalCost : drpCost; // no competitor => pass-through
  const margin = Math.max(0, Number((customerRate - drpCost).toFixed(2)));
  return {
    customerRate: Number(customerRate.toFixed(2)),
    margin,
    // PS-220-D: use the REAL competitor count threaded on the projected stamp; fall back to the
    // legacy `competitor ? 1 : 0` (byte-identical) when an older stamp did not carry the count.
    competitorCount: competitor?.competitorCount ?? (competitor ? 1 : 0),
    sourceCarrier: competitor?.carrierCode ?? null,
    sourceService: competitor?.serviceCode ?? null,
    sourceProviderAccountId: competitor?.providerAccountId ?? null,
  };
}

/**
 * Pure writer GATE for the realized capture: the record to write, or null to SKIP — composes the three
 * skip conditions the IO shell must honor so they are provable OFFLINE (the audit flagged this gate as
 * behaviorally untested). The money-safety invariant lives here: a NON-opted-in client never yields a
 * row, regardless of cost or stamp.
 *   - invalid / non-positive drp_cost -> null (unknown cost; never write)
 *   - client NOT opted in             -> null (DEFAULT-OFF: no house billing without explicit opt-in)
 *   - no projected house stamp        -> null (rated before opt-in / not a SHIPP-winning save)
 */
export function planRealizedHouseCapture(input: {
  drpCost: number;
  optedIn: boolean;
  shippingMarginPolicy?: Pick<ShippingMarginPolicy, 'mode'> | null;
  best: OrderBestRateDto | null;
}): RealizedHouseMargin | null {
  if (!Number.isFinite(input.drpCost) || input.drpCost <= 0) return null;
  const marginEnabled = input.shippingMarginPolicy
    ? input.shippingMarginPolicy.mode === 'next_best_customer_rate'
    : input.optedIn;
  if (!marginEnabled) return null;
  return houseMarginFromProjection(input.best, input.drpCost);
}
