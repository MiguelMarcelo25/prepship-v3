// Canonical owner: is a billing row's destination international?
//
// Backend-owned on purpose. "International" is a business rule, not a string
// comparison, and it decides an operator-facing flag on a money surface — so the
// frontend renders the badge the backend emits and never derives it from a country
// value itself (PS-316).
//
// The rule, confirmed by DJ on 2026-08-05: US and the territories/freely-associated
// states that ship at USPS DOMESTIC rates are domestic. Puerto Rico carries country
// code 'PR', not 'US', so a naive `country !== 'US'` would badge it international even
// though it ships domestically.
//
// Missing country is NOT international. 293 orders in the last 120 days carry no
// country at all; defaulting those to international would invent a fact the data does
// not contain. They stay unbadged and indistinguishable from domestic, which is the
// honest reading of "we don't know".

/** Country codes that ship at USPS domestic rates. */
const DOMESTIC_COUNTRY_CODES = new Set([
  'US', // United States
  'PR', // Puerto Rico
  'VI', // US Virgin Islands
  'GU', // Guam
  'AS', // American Samoa
  'MP', // Northern Mariana Islands
  'UM', // US Minor Outlying Islands
  'FM', // Micronesia — freely associated, USPS domestic
  'MH', // Marshall Islands — freely associated, USPS domestic
  'PW', // Palau — freely associated, USPS domestic
]);

/** Spellings providers send instead of the ISO code. */
const US_ALIASES = new Set([
  'USA',
  'U.S.',
  'U.S.A.',
  'UNITED STATES',
  'UNITED STATES OF AMERICA',
]);

export type DestinationCountryClassification = {
  /** Normalized country code, or null when the order carries no country. */
  countryCode: string | null;
  /** True only when the destination is genuinely outside the US domestic postal area. */
  isInternational: boolean;
};

/**
 * Classify a raw provider country value. Tolerates the shapes seen in
 * orders.raw->'shipTo'->>'country': absent, blank, lowercase, and US aliases.
 */
export function classifyDestinationCountry(raw: unknown): DestinationCountryClassification {
  if (typeof raw !== 'string') return { countryCode: null, isInternational: false };
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return { countryCode: null, isInternational: false };
  if (US_ALIASES.has(trimmed)) return { countryCode: 'US', isInternational: false };
  return {
    countryCode: trimmed,
    isInternational: !DOMESTIC_COUNTRY_CODES.has(trimmed),
  };
}

/** Badge emitted on billing rows whose destination is outside the US domestic area. */
export const INTERNATIONAL_BILLING_BADGE = 'INTERNATIONAL';
