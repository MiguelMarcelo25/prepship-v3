import { getSetting } from '../settings.js';

/**
 * Persisted operator intent for the HUGRAB automatic-insurance policy.
 *
 * Missing or malformed values fail safe to enabled so a storage/configuration
 * problem cannot silently remove the existing $100 coverage requirement.
 * shipping-service-eligibility remains the canonical owner that applies the
 * policy to quote and label inputs.
 */
export const HUGRAB_DEFAULT_INSURANCE_SETTING_KEY = 'hugrab_default_insurance';

export function parseHugrabDefaultInsuranceEnabled(value: string | null | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() !== 'disabled';
}

export async function loadHugrabDefaultInsuranceEnabled(): Promise<boolean> {
  return parseHugrabDefaultInsuranceEnabled(
    await getSetting(HUGRAB_DEFAULT_INSURANCE_SETTING_KEY),
  );
}
