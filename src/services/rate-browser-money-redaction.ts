// PS-220 — pure money redaction for the /rates/browse serializers. Extracted from src/routes/rates.ts
// so the rate-browser leak surface (the projected house stamp's competitor cost) is provable
// behaviorally by an offline guard, and the key set has ONE owner that cannot silently drift from what
// the projection writes. Non-financial / client_user viewers get every money-bearing field nulled;
// non-money fields (carrier/service codes, account ids) are preserved.

// Raw provider rate money keys (snake_case) AND the camelCase competitor-cost keys the PS-220 projected
// stamp writes onto bestRate.nextBestNonHouseRate (shipmentCost/otherCost/totalCost). houseMargin is the
// INTERNAL SHIPP spread. All are nulled for a viewer who cannot see financials.
import {
  CANONICAL_SHIPPING_RATE_MONEY_KEYS,
  LEGACY_SHIPPING_RATE_MONEY_KEYS,
} from './shipping-workflow/shipping-rate-money-normalizer';

export const RATE_BROWSER_MONEY_FIELD_KEYS: ReadonlySet<string> = new Set([
  'shipping_amount',
  'other_amount',
  'insurance_amount',
  'confirmation_amount',
  'original_amount',
  'list_amount',
  'retail_amount',
  'negotiated_amount',
  'cost',
  'labelCost',
  'rawCost',
  'amount',
  ...CANONICAL_SHIPPING_RATE_MONEY_KEYS,
  ...LEGACY_SHIPPING_RATE_MONEY_KEYS,
  'houseApplied',
  'houseBadgeVisible',
  'customerRateSource',
  'rateCostSource',
  'shipmentCost', // PS-220 stamp: nextBestNonHouseRate competitor cost — INTERNAL
  'otherCost',    // PS-220 stamp: competitor surcharge cost — INTERNAL
  'totalCost',    // PS-220 stamp: competitor total + the SHIPP bestRate total — INTERNAL
  'houseMargin',
]);

/** Recursively null every RATE_BROWSER_MONEY_FIELD_KEYS value (objects + arrays); leave everything else. */
export function redactRateBrowserMoney<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactRateBrowserMoney(entry)) as T;
  }
  if (typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(source)) {
    redacted[key] = RATE_BROWSER_MONEY_FIELD_KEYS.has(key) ? null : redactRateBrowserMoney(nestedValue);
  }
  return redacted as T;
}
