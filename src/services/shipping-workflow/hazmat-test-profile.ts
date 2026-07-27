import { TEST_FIXTURE_CARRIER_CODE } from '../test-rate-fixture.js';

/**
 * Hazmat profile for the deterministic test-fixture carrier.
 *
 * Every other profile in the registry is gated on real carrier certification and
 * stays disabled until proven against a live account. This one is the opposite:
 * it exists so the hazmat workflow can be exercised end to end -- declaration,
 * rating, purchase, and the HAZMAT markings on the label PDF -- without any
 * carrier being certified and without a single real order being at risk.
 *
 * It is safe because it is unreachable for real clients by construction:
 *
 *  1. It resolves only for carrier code `prepship_test`, which is produced
 *     exclusively by buildTestFixtureRates.
 *  2. Those fixture rates are only generated when clients.is_test is true
 *     (the PS-186 authority) -- see rates.ts.
 *  3. The capability is additionally gated on isTestClient here, so even a
 *     forged carrier code on a real client resolves to unsupported.
 *  4. PS-186's test-label policy independently forces mock labels for test
 *     clients, so this path can never buy postage.
 *
 * A real carrier still requires its own certified profile. This grants nothing
 * to Stamps.com, UPS, or Walmart.
 */
export const HAZMAT_TEST_PROFILE_CARRIER_CODE = TEST_FIXTURE_CARRIER_CODE;

/** True when the rate came from the test-fixture carrier. */
export function isHazmatTestFixtureCarrier(carrierCode: string): boolean {
  return carrierCode === HAZMAT_TEST_PROFILE_CARRIER_CODE;
}

export const HAZMAT_TEST_PROFILE_WARNINGS = [
  'Test-fixture carrier: no postage is ever purchased and no carrier is notified.',
  'Label markings are rendered by the mock label generator for verification only.',
] as const;

/**
 * Why the test profile is unavailable, or null when it is usable.
 * Kept separate from the real-carrier reasons so the operator is never told a
 * test carrier is "pending provider certification" -- it never will be.
 */
export function hazmatTestProfileUnavailableReason(input: {
  featureEnabled: boolean;
  isTestClient: boolean;
  rateEnabled: boolean;
  purchaseEnabled: boolean;
}): string | null {
  if (!input.isTestClient) return 'The test hazmat profile applies only to test clients.';
  if (!input.featureEnabled) return 'Hazmat is not enabled for this client.';
  if (!input.rateEnabled) return 'Hazmat rating is disabled.';
  if (!input.purchaseEnabled) return 'Hazmat purchase is disabled.';
  return null;
}
