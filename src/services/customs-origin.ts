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
 * The origin to declare to a provider, given the resolution and the operator's configured
 * default.
 *
 * `mixed` and `unknown` both fall back, and that is a KNOWN limitation rather than a
 * decision: one synthetic package line item has room for one origin, so a mixed carton
 * cannot be declared truthfully in this shape at all. Fixing that means per-product line
 * items, which belongs to the customs builder in PS-492 — restructuring the Shipp request
 * body would change what 246 live domestic shipments send, for a field that carries no
 * customs meaning on a domestic lane.
 *
 * Returning the fallback rather than throwing is deliberate: origin is irrelevant on the
 * domestic lane that is the only lane PrepShip can actually ship today (PS-492), so
 * refusing the label would break real shipments to fix a declaration nobody reads.
 */
export function declaredCountryOfManufacture(
  resolution: CustomsOriginResolution,
  configuredDefault: string | null | undefined,
): string {
  if (resolution.kind === 'single') return resolution.country;
  return isoCountry(configuredDefault) ?? 'US';
}
