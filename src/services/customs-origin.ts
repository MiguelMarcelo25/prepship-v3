/**
 * Canonical owner: what country of origin does PrepShip declare for an order's contents?
 *
 * PS-494. `src/connectors/carrier/shipp.ts` hardcoded `countryOfManufacture: 'US'` on
 * every quote and label sent to the Shipp broker — the only occurrence of that field in
 * the repository, with no override and no consumer. Country of origin is a declarable
 * customs fact, not a formatting default, so a constant is the wrong shape regardless of
 * whether it happens to be right.
 *
 * It does not happen to be right. DJ confirmed on 2026-08-07 that Dr Prepper's own goods
 * are US-manufactured AND that the non-US values recorded against client goods are
 * correct. PrepShip is a 3PL: origin is a property of the ITEM being shipped, not of the
 * business. Of 333 customs line items ShipStation recorded, 311 are US, 21 are KR and 1 is
 * CN — 22 line items across 14 orders, being Korean cosmetics, Korean consumer
 * electronics, Korean ramen and a Chinese children's book series.
 *
 * The data was already there and unread. `order-raw-payload-policy.ts` deliberately
 * retains `internationalOptions`, and `countryOfOrigin` is populated on 333 of 333 items.
 * Before this module the only reference to that blob outside the retention list was a
 * guard script.
 *
 * Backend-owned (PS-316): a customs declaration is business truth. The connector is an
 * adapter — it translates the resolved answer into the provider's shape and does not
 * decide what the answer is.
 */

// Type-only: the destination rule keeps its single owner. This module consumes that
// classification, it never re-derives "is this international" from a country comparison.
import type { BillingDestination } from './billing-destination-international';

/** How confident we are about a single declarable origin for the whole package. */
export type CustomsOriginResolution =
  /** Every customs item agrees. `country` is that ISO-2 code. */
  | { kind: 'single'; country: string }
  /**
   * The items disagree. A carton can genuinely mix US and KR goods, and the current
   * single synthetic `packageLineItems[0]` cannot express more than one origin — so this
   * is a shape limitation, reported rather than silently resolved. `countries` is the
   * distinct set, sorted, for diagnostics and for the eventual per-item builder.
   */
  | { kind: 'mixed'; countries: string[] }
  /** No customs items, or none carrying a usable origin. */
  | { kind: 'unknown' };

type CustomsItemLike = { countryOfOrigin?: unknown };

function isoCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  // An ISO alpha-2 code is exactly two letters. Anything else is unusable rather than
  // foreign -- the same test classifyDestinationCountry applies to a destination.
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * Resolve the declarable origin from an order's customs items.
 *
 * Pure, so the rule is testable without a database or a provider. Items with no usable
 * origin are IGNORED rather than treated as unknown: 4 of the 333 recorded items carry an
 * origin but no description and no HS code, and other partial records are likely — one
 * incomplete line should not erase a fact the rest of the carton agrees on.
 */
export function resolveCustomsOrigin(items: readonly CustomsItemLike[] | null | undefined): CustomsOriginResolution {
  if (!Array.isArray(items) || items.length === 0) return { kind: 'unknown' };

  const countries = new Set<string>();
  for (const item of items) {
    const country = isoCountry(item?.countryOfOrigin);
    if (country) countries.add(country);
  }

  if (countries.size === 0) return { kind: 'unknown' };
  if (countries.size === 1) return { kind: 'single', country: [...countries][0]! };
  return { kind: 'mixed', countries: [...countries].sort() };
}

/**
 * Read the customs items out of a retained ShipStation payload.
 *
 * There is no customs COLUMN anywhere in the schema; the items live only inside
 * `orders.raw->'internationalOptions'->'customsItems'`, retained on purpose by
 * `order-raw-payload-policy.ts`. Tolerates the shapes actually seen in production: the
 * key absent, present but not an array, or an array of non-objects.
 */
export function customsItemsFromOrderRaw(raw: unknown): CustomsItemLike[] {
  const record = (raw ?? {}) as Record<string, unknown>;
  const international = (record.internationalOptions ?? {}) as Record<string, unknown>;
  const items = international.customsItems;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is CustomsItemLike => !!item && typeof item === 'object');
}

/** Convenience: resolve straight from an order row carrying its retained payload. */
export function resolveOrderCustomsOrigin(order: { raw?: unknown } | null | undefined): CustomsOriginResolution {
  return resolveCustomsOrigin(customsItemsFromOrderRaw(order?.raw));
}

/**
 * The single agreed origin, or null when the carton is mixed or has no usable customs
 * items.
 *
 * This is what the backend hands to a connector: a resolved FACT or an explicit absence.
 * The connector then applies its own credential-configured default, because credentials
 * are the adapter's concern — but it never decides the origin itself.
 */
export function singleCustomsOriginOrNull(resolution: CustomsOriginResolution): string | null {
  return resolution.kind === 'single' ? resolution.country : null;
}

/**
 * What origin may be declared to a provider — a FACT, or a refusal.
 *
 * PS-494 correction. The previous `declaredCountryOfManufacture` collapsed `mixed` and
 * `unknown` into the configured default (or `'US'`) unconditionally, which is how a guessed
 * origin reached the broker on every quote. The audit's objection was exact: reporting
 * `mixed` internally does not make the transmitted request truthful.
 *
 * The decision now turns on whether the field is actually a customs declaration:
 *
 *  - `single`  — a resolved fact. Declare it, wherever it is going.
 *  - `mixed`   — REFUSE. One synthetic package line item has room for one origin, so a
 *                carton mixing US and KR goods cannot be declared truthfully in this shape.
 *                Refusing before provider HTTP is the honest outcome; per-product line items
 *                are the alternative and belong to PS-492's customs builder, which would
 *                change the body shape 246 live domestic shipments send against a provider
 *                contract this repo has never verified.
 *  - `unknown` + DOMESTIC destination — declare the operator default (or `'US'`). Country of
 *                origin carries no customs significance on a domestic lane; no declaration is
 *                filed with any authority. This is the one guess that is allowed, and it is
 *                allowed EXPLICITLY, here, in one named branch — not silently at the bottom
 *                of a connector helper.
 *  - `unknown` + anything else — REFUSE. A missing country (`Needs Review`) counts as "not
 *                domestic": fail closed, because the whole point is to stop asserting an
 *                origin we do not know onto a real cross-border declaration.
 *
 * Pure: takes the destination classification rather than re-deriving it, so the destination
 * rule keeps its single owner in `billing-destination-international.ts`.
 */
export type CustomsOriginDecision =
  | { kind: 'declare'; country: string; basis: 'resolved' | 'domestic_default' }
  | { kind: 'refuse'; reason: string };

export function decideDeclaredOrigin(input: {
  resolution: CustomsOriginResolution;
  /** From `classifyDestinationCountry(...).destination` — this module never re-derives it. */
  destination: BillingDestination;
  configuredDefault?: string | null;
}): CustomsOriginDecision {
  const { resolution, destination } = input;

  if (resolution.kind === 'single') {
    return { kind: 'declare', country: resolution.country, basis: 'resolved' };
  }

  if (resolution.kind === 'mixed') {
    return {
      kind: 'refuse',
      reason:
        `This order mixes goods from ${resolution.countries.join(', ')}. A single package line ` +
        'item cannot declare more than one country of origin, so no truthful origin can be sent. ' +
        'Resolve the customs items or use a provider path that supports per-item declarations.',
    };
  }

  if (destination === 'Domestic') {
    return {
      kind: 'declare',
      country: isoCountry(input.configuredDefault) ?? 'US',
      basis: 'domestic_default',
    };
  }

  return {
    kind: 'refuse',
    reason:
      'No country of origin is recorded for this order and the destination is not domestic ' +
      `(${destination}), so the origin would be a guess on a real customs declaration. ` +
      'Record customs items on the order before quoting or buying this label.',
  };
}

/**
 * Thrown when no truthful origin can be declared.
 *
 * `status` is set deliberately: `main.ts` reads `err.status` and returns the message verbatim
 * only for a 4xx, replacing anything else with "Internal server error". Without it, an
 * operator would see a generic 500 for a refusal that has a precise, actionable reason —
 * the exact failure PS-472 was raised to fix.
 */
export class CustomsOriginUndeclarableError extends Error {
  readonly code = 'CUSTOMS_ORIGIN_UNDECLARABLE';
  readonly status = 422;

  constructor(reason: string) {
    super(reason);
    this.name = 'CustomsOriginUndeclarableError';
  }
}

/**
 * Assert a declarable origin, for callers that should refuse outright (the label-purchase
 * funnel). Returns the resolved country, or `null` on the domestic-inert branch where the
 * connector may apply its configured default.
 *
 * Rate browsing does NOT use this — it needs the reason as a per-carrier diagnostic so the
 * other carriers still quote, so it consumes `decideDeclaredOrigin` directly.
 */
export function assertDeclarableOrigin(input: {
  resolution: CustomsOriginResolution;
  destination: BillingDestination;
  configuredDefault?: string | null;
}): string | null {
  const decision = decideDeclaredOrigin(input);
  if (decision.kind === 'refuse') throw new CustomsOriginUndeclarableError(decision.reason);
  return decision.basis === 'resolved' ? decision.country : null;
}
