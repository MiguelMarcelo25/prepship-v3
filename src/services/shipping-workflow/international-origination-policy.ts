import { classifyDestinationCountry } from '../billing-destination-international.js';

/**
 * Canonical owner: may PrepShip originate a label to this destination?
 *
 * PS-492. Today the answer for anywhere outside the US domestic area is NO, and the
 * honest thing is to say so before an operator starts a purchase that cannot succeed.
 *
 * ── Why a buy cannot succeed ───────────────────────────────────────────────
 * Four independent blockers, any one sufficient:
 *   1. `src/lib/carrier-service-catalog.ts` — the canonical account→service catalog holds
 *      ZERO international service codes. Not filtered out; never populated.
 *   2. `src/lib/shipstation/label-request-body.ts` — the label POST body has no `customs`
 *      key, and there is no customs builder anywhere to delegate to.
 *   3. `createLabelV2Impl` — its guard chain (scope, shipped/cancelled lock, shipping
 *      safety, quote authorization, hazmat, insurance, PO-Box, residential parity,
 *      carrier-family eligibility, weight) had NO destination check at all. This closes
 *      that hole.
 *   4. `shipping-quote-authorization.ts` — uppercases the country without ISO-2 aliasing,
 *      so a raw 'Canada' seals as 'CANADA' while the rate priced 'CA'.
 *
 * Production bears it out: 0 of 1,101 PrepShip-originated labels are international. All
 * 15 international shipment records were synced in from ShipStation, where a human bought
 * the label outside PrepShip.
 *
 * ── Why this blocks rather than builds ─────────────────────────────────────
 * Building origination needs a customs declaration, an international service catalog, and
 * a decision about whether international is in scope at all — none of which this gate
 * presumes. Blocking is correct under EVERY answer to that question: if international is
 * out of scope the refusal is right permanently, and if it is in scope the refusal is
 * still right until origination exists. Removing this gate is exactly the last step of
 * building the feature, not a workaround for it.
 *
 * ── Deliberately NOT blocked ───────────────────────────────────────────────
 * An UNKNOWN country. 293 production orders carry no country at all, and they are
 * overwhelmingly domestic orders with a missing field — refusing them would break real,
 * currently-working shipments to prevent a hypothetical one. Only a destination the
 * canonical classifier positively identifies as International is refused. That classifier
 * is also why PR/VI/GU/AS/MP/UM pass: they are not 'US' but they ship domestically, the
 * same trap PS-493 fixed in the insurance tier.
 */

export class InternationalOriginationUnsupportedError extends Error {
  readonly code = 'INTERNATIONAL_ORIGINATION_UNSUPPORTED';
  readonly details: { toCountry: string };

  constructor(toCountry: string) {
    super(
      `PrepShip cannot buy a label to ${toCountry}. International origination is not supported: `
      + 'no international carrier service is configured and no customs declaration can be built. '
      + 'Purchase this label directly with the carrier or in ShipStation.',
    );
    this.name = 'InternationalOriginationUnsupportedError';
    this.details = { toCountry };
  }
}

/**
 * Refuse a label purchase whose destination is outside the US domestic area.
 *
 * Called at the single label-purchase funnel with the SEALED provider address — the same
 * value that would be sent to the carrier — so the gate cannot be bypassed by an
 * authorized quote carrying a different country than the request body.
 */
export function assertInternationalOriginationSupported(input: {
  toCountry: unknown;
}): void {
  const classification = classifyDestinationCountry(input.toCountry);
  if (classification.destination !== 'International') return;
  throw new InternationalOriginationUnsupportedError(classification.countryCode ?? 'that destination');
}

export function isInternationalOriginationUnsupportedError(
  error: unknown,
): error is InternationalOriginationUnsupportedError {
  return error instanceof InternationalOriginationUnsupportedError;
}
