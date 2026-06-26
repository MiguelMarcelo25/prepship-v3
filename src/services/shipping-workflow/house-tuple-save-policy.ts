import { isInternalHouseRate } from '../../lib/next-best-non-house-rate';
import type { ShippingMarginPolicy } from '../house-account-opt-in';

/**
 * PS-292 (items 2 + 4) — backend-owned verdict + reject for a persisted best rate's SHIPP house tuple.
 *
 * A persisted best_rate_json is a "half-house" rate when its winning rate is the SHIPP/house carrier for
 * an OPTED-IN client but its competitor tuple (nextBestNonHouseRate + houseMargin) is ABSENT — so PS-220
 * can never compute a margin. The tuple is only ever written by the shared stampHouseTuple owner
 * (house-tuple-stamp.ts), which runs in /rates/browse + rates-backfill; a save that bypassed it (a manual
 * FE apply that dropped the fields) lands here with both fields null.
 *
 * SHIPP identity is PROVIDER-ONLY (the connector rewrites carrier_code to fedex/ups/...), and the FE's
 * translateRateToV2Shape drops the top-level provider — so callers MUST pass the RAW provider
 * (body.bestRateJson.raw?.provider), never carrier_code.
 *
 * Safety linchpin: a GENUINE no-competitor SHIPP win is NOT half-house — stampHouseTuple writes
 * nextBestNonHouseRate=null but houseMargin=0 (not null). So 'both null' only happens when the save
 * NEVER went through the stamp owner. Legitimate house wins (with a competitor, or a real $0-margin
 * pass-through) are 'present' and save normally.
 */
export type HouseTupleStatus = 'not_house' | 'present' | 'needs_refresh';

export const HOUSE_TUPLE_REQUIRED_MESSAGE =
  'House Account SHIPP rate is missing its competitor tuple — re-rate via Rate Browser before saving';

export function houseTupleStatus(input: {
  rawProvider: unknown;
  nextBestNonHouseRate: unknown;
  houseMargin: number | null | undefined;
  optedIn: boolean;
  shippingMarginPolicy?: Pick<ShippingMarginPolicy, 'mode'> | null;
}): HouseTupleStatus {
  // Default-OFF inert: non-opted-in clients + non-SHIPP winners are never house rows.
  const marginEnabled = input.shippingMarginPolicy
    ? input.shippingMarginPolicy.mode === 'next_best_customer_rate'
    : input.optedIn;
  if (!marginEnabled) return 'not_house';
  if (!isInternalHouseRate({ provider: input.rawProvider } as Parameters<typeof isInternalHouseRate>[0])) {
    return 'not_house';
  }
  const tupleMissing = input.nextBestNonHouseRate == null && input.houseMargin == null;
  return tupleMissing ? 'needs_refresh' : 'present';
}

/** A half-house save (verdict 'needs_refresh') should be rejected. The route gates the actual 400 behind
 *  the default-OFF HOUSE_TUPLE_SAVE_GUARD canary so prod stays byte-identical until DJ flips it. */
export function shouldRejectHalfHouseSave(status: HouseTupleStatus): boolean {
  return status === 'needs_refresh';
}
