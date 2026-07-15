/**
 * PS-135(b)/PS-433: canonical backend Policy-B rate block list.
 *
 * The backend rate owner enforces service, package, provider-account, and
 * store-exception rules before official ranking. Frontends consume the
 * resulting eligibility DTO facts and do not import or reapply this policy.
 *
 * Policy A (client-conditional service eligibility such as HUGRAB Ground
 * Saver) lives in shipping-service-eligibility.ts. This module is Policy B:
 * global service/package/provider exclusions. Pure constants and predicate,
 * with zero imports.
 */

/** USPS economy / media classes blocked from selection (with a media-mail store exception). */
export const BLOCKED_SERVICE_CODES = new Set<string>([
  'usps_media_mail',
  'usps_first_class_mail',
  'usps_library_mail',
  'usps_parcel_select',
  'usps_parcel_select_lightweight',
]);

/** Flat-rate / regional-rate package types blocked from selection. */
export const BLOCKED_PACKAGE_TYPES = new Set<string>([
  'flat_rate_envelope',
  'flat_rate_legal_envelope',
  'flat_rate_padded_envelope',
  'small_flat_rate_box',
  'medium_flat_rate_box',
  'large_flat_rate_box',
  'regional_rate_box_a',
  'regional_rate_box_b',
]);

/** Blocked ShipStation shipping-provider IDs, enforced by the backend rate owner. */
export const BLOCKED_CARRIER_IDS = new Set<number>([
  442017, // Amazon Buy Shipping
  566344, // Sendle
  593739, // Amazon Shipping US
]);

/** Catches flat-rate / box service names (for example, Priority Mail Flat Rate Envelope). */
export const BLOCKED_NAME_RE = /flat[\s-]?rate|\bbox\b/i;

/** Stores explicitly permitted to use USPS Media Mail (overrides Policy B). */
export const MEDIA_MAIL_ALLOWED_STORES = new Set<number>([376759]);

/** Resolve the ShipStation carrier id to its provider-account eligibility verdict. */
export function isProviderAccountBlocked(carrierId: string | null | undefined): boolean {
  const match = /^se-(\d+)$/i.exec(String(carrierId ?? ''));
  const providerId = match ? Number.parseInt(match[1]!, 10) : null;
  return providerId != null && BLOCKED_CARRIER_IDS.has(providerId);
}

/** Core service/package/name rule; the backend owner composes store/account context. */
export function isServiceOrPackageBlocked(
  serviceCode: string | null | undefined,
  packageType: string | null | undefined,
  serviceName: string | null | undefined,
): boolean {
  return (
    BLOCKED_SERVICE_CODES.has(serviceCode ?? '') ||
    BLOCKED_PACKAGE_TYPES.has(packageType ?? '') ||
    BLOCKED_NAME_RE.test(serviceName ?? '')
  );
}
