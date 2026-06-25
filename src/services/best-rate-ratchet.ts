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
// inputs = same lane = directly comparable), the incoming total is STRICTLY higher, AND the incoming
// re-quote is NOT a proven-COMPLETE pass. Everything else is allowed: no prior (cold/first), a missing
// fingerprint on either side, a DIFFERENT fingerprint (weight/dims/residential/zip changed -> the prior
// is stale and MUST be replaced), an incoming that is cheaper-or-equal, or an incoming that is a
// COMPLETE re-quote. Pure (no DB/IO) so the persist owners + the offline guard exercise the identical
// rule. The operator's deliberate FE save is EXEMPT (it is not an automated re-persist).
//
// Display-drift carve-out: the original rule blocked EVERY same-inputs increase, which also suppressed
// a GENUINE carrier price rise (the carrier raised Ground within the cache window) — leaving the
// Awaiting Best Rate showing a stale-cheap value the operator could not act on truthfully. A COMPLETE
// re-quote (every required carrier reached a terminal result; not the thin Shipp set PS-271 guards
// against) IS the true current price and must overwrite. Only a thin/partial higher re-quote
// (isComplete !== true) is still blocked — exactly the FedEx-only-dropped-UPS flicker case.
import type { OrderBestRateDto } from './order-rate-dto';

type RatchetRate =
  | Pick<OrderBestRateDto, 'shipmentCost' | 'otherCost' | 'totalCost' | 'requestFingerprint' | 'isComplete'>
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
 * True when persisting `incoming` over `prior` would be a same-inputs price DOWNGRADE that should be
 * BLOCKED — the caller keeps the prior best. Blocked only for a THIN/partial more-expensive re-quote;
 * a COMPLETE more-expensive re-quote (a genuine carrier increase) is ALLOWED so the displayed best
 * rate stays the true current price.
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
  const incomingIsMoreExpensive = incomingTotal > priorTotal + EPSILON;
  if (!incomingIsMoreExpensive) return false; // cheaper-or-equal for the SAME inputs => always overwrite
  // More-expensive for the same inputs: block ONLY a thin/partial re-quote (the PS-271 Shipp flicker).
  // A proven-COMPLETE higher re-quote is the genuine current price and MUST overwrite. `null`/absent
  // completeness on the INCOMING (legacy/unknown) is treated as not-proven => still blocked, as before.
  return incoming.isComplete !== true;
}
