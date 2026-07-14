/**
 * Rate block-list utilities (display-side eligibility guard only).
 *
 * Per PS-313/PS-316, markup/rate money math is backend-owned
 * (`src/services/shipping-workflow/rate-money.ts` + `markup-resolver.ts`). Keep
 * this module limited to the shared display-side block-list check.
 */

import type { Rate } from '../types/orders';

// PS-135(b): Policy-B block list now lives in the canonical owner (src/lib/rate-block-list.ts), shared
// with the backend (src/services/rates.ts) so the FE and backend copies cannot drift. Imported +
// re-exported here to keep this module's surface stable.
import {
  BLOCKED_SERVICE_CODES,
  BLOCKED_PACKAGE_TYPES,
  BLOCKED_CARRIER_IDS,
  MEDIA_MAIL_ALLOWED_STORES,
  isServiceOrPackageBlocked,
} from '../../../src/lib/rate-block-list';

export { BLOCKED_SERVICE_CODES, BLOCKED_PACKAGE_TYPES, BLOCKED_CARRIER_IDS, MEDIA_MAIL_ALLOWED_STORES };

// PS-135: the frontend pickBestRate() was removed — it had ZERO callers and was a parallel
// client-side rate selector with no insurance/eligibility guard that would diverge from the
// backend's authoritative pickBestRate (src/services/rates.ts). The backend owns best-rate
// selection; the FE consumes response.bestRate.

export function isBlockedRate(rate: Rate | null | undefined, storeId?: number): boolean {
  if (!rate) return false;

  if (
    rate.serviceCode === 'usps_media_mail' &&
    storeId != null &&
    MEDIA_MAIL_ALLOWED_STORES.has(Number.parseInt(String(storeId), 10))
  ) {
    return false;
  }

  return BLOCKED_CARRIER_IDS.has(rate.shippingProviderId ?? -1) ||
    isServiceOrPackageBlocked(rate.serviceCode, rate.packageType, rate.serviceName);
}
