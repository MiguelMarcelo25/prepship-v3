// PS-271 — no-downgrade persist ratchet for the Awaiting Best Rate.
//
// The Shipp direct-carrier quote is uncached + non-deterministic: the SAME shipment (same weight/dims/
// destination) sometimes returns UPS+FedEx, sometimes FedEx-only. A FedEx-only ("thin") response is a
// valid HTTP 200, so it gets persisted and the Awaiting Best Rate diverges from the Rate Browser
// cheapest (#1502: persisted FedEx $11.66 when UPS $10.14 was available a tick earlier; 9+ such rows,
// all 31 oz). This ratchet stops an AUTOMATED re-persist (backfill / strict-recalc) from REPLACING a
// fresher, CHEAPER committed best for the SAME shipment inputs with a more-expensive one.
//
// Block ONLY when ALL hold: a prior best exists, it shares the incoming requestFingerprint (same
// inputs = same lane = directly comparable), and the incoming total is STRICTLY higher. Everything
// else is allowed: no prior (cold/first), a missing fingerprint on either side, a DIFFERENT
// fingerprint (weight/dims/residential/zip changed -> the prior is stale and MUST be replaced), or an
// incoming that is cheaper-or-equal. Pure (no DB/IO) so the persist owners + the offline guard exercise
// the identical rule. The operator's deliberate FE save is EXEMPT (it is not an automated re-persist).
import type { OrderBestRateDto } from './order-rate-dto';

type RatchetRate =
  | Pick<OrderBestRateDto, 'shipmentCost' | 'otherCost' | 'totalCost' | 'requestFingerprint'>
  | null
  | undefined;

const EPSILON = 0.005; // sub-cent float-noise guard

/** The comparable billed total: prefer totalCost, else shipmentCost + otherCost; null if uncomputable. */
export function comparableRateTotal(rate: RatchetRate): number | null {
  if (!rate) return null;
  if (typeof rate.totalCost === 'number' && Number.isFinite(rate.totalCost)) return rate.totalCost;
  const shipment =
    typeof rate.shipmentCost === 'number' && Number.isFinite(rate.shipmentCost) ? rate.shipmentCost : null;
  if (shipment == null) return null;
  const other = typeof rate.otherCost === 'number' && Number.isFinite(rate.otherCost) ? rate.otherCost : 0;
  return shipment + other;
}

/**
 * True when persisting `incoming` over `prior` would be a same-inputs price DOWNGRADE — the caller
 * should KEEP the prior best instead of overwriting it with the more-expensive thin re-quote.
 */
export function isNoDowngradeBlocked(prior: RatchetRate, incoming: RatchetRate): boolean {
  if (!prior || !incoming) return false;
  const priorFp = prior.requestFingerprint ?? null;
  const incomingFp = incoming.requestFingerprint ?? null;
  // Different or absent fingerprint => not the same shipment inputs => not a comparable downgrade.
  if (!priorFp || !incomingFp || priorFp !== incomingFp) return false;
  const priorTotal = comparableRateTotal(prior);
  const incomingTotal = comparableRateTotal(incoming);
  if (priorTotal == null || incomingTotal == null) return false; // never block on missing data
  return incomingTotal > priorTotal + EPSILON; // strictly more expensive for the SAME inputs => block
}
