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
// Missing country is NOT international, and PS-488 AC-2 adds that it is not Domestic
// either. 293 orders in the last 120 days carry no country at all. The badge could only
// say international-or-not, so those orders went unbadged and read as domestic — which
// this file previously called "the honest reading of we don't know". It was not: it made
// a gap indistinguishable from a verified US address.
//
// The Destination COLUMN has room for the third answer, so unknown is `Needs Review`.
// Same underlying data, a surface that can express uncertainty, therefore a better rule.

/**
 * PS-488 AC-2 — the exact list the card enumerates: the 50 states, DC, APO/FPO/DPO
 * (which carry country US with an AA/AE/AP state) and the six US territories.
 *
 * FM / MH / PW (Micronesia, Marshall Islands, Palau) were previously in this set on the
 * grounds that they ship at USPS domestic RATES. AC-2 does not list them, and they are
 * sovereign nations rather than US territories, so they classify as International here.
 * The postal-rate fact and the billing-classification fact are not the same fact; this
 * owner answers the billing one.
 */
const DOMESTIC_COUNTRY_CODES = new Set([
  'US', // United States (incl. DC and APO/FPO/DPO military addresses)
  'PR', // Puerto Rico
  'VI', // US Virgin Islands
  'GU', // Guam
  'AS', // American Samoa
  'MP', // Northern Mariana Islands
  'UM', // US Minor Outlying Islands
]);

/** Spellings providers send instead of the ISO code. */
const US_ALIASES = new Set([
  'USA',
  'U.S.',
  'U.S.A.',
  'UNITED STATES',
  'UNITED STATES OF AMERICA',
]);

/**
 * PS-488 AC-2 — the three states a Billing Destination column may show.
 *
 * `Needs Review` is the important one. A missing or unparseable country is a GAP, and
 * the AC is explicit that it must never be guessed Domestic. The badge could not express
 * this — a badge has only two states, present or absent — so unknown had to read as
 * "not international". A column can say "we do not know", so it must.
 */
export type BillingDestination = 'Domestic' | 'International' | 'Needs Review';

export type DestinationCountryClassification = {
  /** Normalized country code, or null when the order carries no country. */
  countryCode: string | null;
  /**
   * True only when the destination is genuinely outside the US domestic area.
   * Unknown is false here: this drives the BADGE, and an absent country is not evidence
   * of an international destination. Use `destination` for the column, which separates
   * "known domestic" from "unknown".
   */
  isInternational: boolean;
  /** AC-2 column value. Never guesses Domestic for a missing/invalid country. */
  destination: BillingDestination;
};

/**
 * Classify a raw provider country value. Tolerates the shapes seen in
 * orders.raw->'shipTo'->>'country': absent, blank, lowercase, and US aliases.
 */
export function classifyDestinationCountry(raw: unknown): DestinationCountryClassification {
  const unknown: DestinationCountryClassification = {
    countryCode: null,
    isInternational: false,
    destination: 'Needs Review',
  };
  if (typeof raw !== 'string') return unknown;
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return unknown;
  if (US_ALIASES.has(trimmed)) {
    return { countryCode: 'US', isInternational: false, destination: 'Domestic' };
  }
  // An ISO alpha-2 code is exactly two letters. Anything else is unparseable rather than
  // foreign — "N/A", "-", a stray postcode — and guessing International would be as wrong
  // as guessing Domestic.
  if (!/^[A-Z]{2}$/.test(trimmed)) return unknown;
  const isDomestic = DOMESTIC_COUNTRY_CODES.has(trimmed);
  return {
    countryCode: trimmed,
    isInternational: !isDomestic,
    destination: isDomestic ? 'Domestic' : 'International',
  };
}

/** Badge emitted on billing rows whose destination is outside the US domestic area. */
export const INTERNATIONAL_BILLING_BADGE = 'INTERNATIONAL';
