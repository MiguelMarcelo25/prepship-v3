import type { ShippingMarginPolicy } from '../house-account-opt-in';

/**
 * PS-292 (items 2 + 4) / PS-333: backend-owned verdict + reject for a persisted
 * best rate's house margin tuple.
 *
 * A persisted best_rate_json is "half-house" when a margin-enabled client saves
 * a rate but its backend customer-rate tuple (nextBestNonHouseRate + houseMargin)
 * is absent. Provider name is not authoritative: PS-333 defines house cost as
 * the backend-finalized rock-bottom cheapest eligible rate, with customer_rate as
 * the next eligible rate above it.
 *
 * Safety linchpin: a genuine no-competitor margin row is not half-house because
 * stampHouseTuple writes nextBestNonHouseRate=null but houseMargin=0. So "both
 * null" only happens when the save never went through the stamp owner.
 */
export type HouseTupleStatus = 'not_house' | 'present' | 'needs_refresh';

export const HOUSE_TUPLE_REQUIRED_MESSAGE =
  'House margin rate is missing its customer-rate tuple - re-rate via Rate Browser before saving';

export function houseTupleStatus(input: {
  rawProvider: unknown;
  nextBestNonHouseRate: unknown;
  houseMargin: number | null | undefined;
  optedIn: boolean;
  shippingMarginPolicy?: Pick<ShippingMarginPolicy, 'mode'> | null;
}): HouseTupleStatus {
  const marginEnabled = input.shippingMarginPolicy
    ? input.shippingMarginPolicy.mode === 'next_best_customer_rate'
    : input.optedIn;
  if (!marginEnabled) return 'not_house';
  const tupleMissing = input.nextBestNonHouseRate == null && input.houseMargin == null;
  return tupleMissing ? 'needs_refresh' : 'present';
}

/** A half-house save (verdict 'needs_refresh') should be rejected. The route gates the actual 400 behind
 *  the default-OFF HOUSE_TUPLE_SAVE_GUARD canary so prod stays byte-identical until DJ flips it. */
export function shouldRejectHalfHouseSave(status: HouseTupleStatus): boolean {
  return status === 'needs_refresh';
}
