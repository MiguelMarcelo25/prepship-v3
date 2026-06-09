/**
 * PS-135(b): canonical Policy-B rate block list — USPS-economy / flat-rate / box package blocking
 * (+ the FE-applied blocked-carrier set). SINGLE SOURCE OF TRUTH for the constants that were
 * previously DUPLICATED verbatim in src/services/rates.ts and web/src/utils/markups.ts. Both now
 * import from here, so the two can no longer drift into an FE↔backend mismatch (the bug class the
 * PS-135(b) drift guard was created to catch — this module makes that drift structurally impossible).
 *
 * This is Policy B. Policy A (HUGRAB UPS Ground Saver, client-conditional) lives in
 * shipping-service-eligibility.ts and is already shared the same way; this module mirrors that pattern.
 *
 * Pure constants + a pure predicate, ZERO imports — safe to import from the FE bundle (web/ imports
 * this directly via ../../../src/lib/rate-block-list, exactly as it imports shipping-service-eligibility).
 *
 * APPLICATION SCOPE (unchanged by the consolidation):
 *   - The service/package/name block (isServiceOrPackageBlocked) is applied BY THE BACKEND
 *     (src/services/rates.ts drops these before returning rates) AND mirrored by the FE.
 *   - BLOCKED_CARRIER_IDS is applied ONLY by the FE (web/src/utils/markups.ts) today; the backend
 *     rate path does not carrier-id-block (those accounts do not produce server-side rates). The set
 *     lives here to be de-duplicated, NOT to change where it is enforced. Moving backend enforcement
 *     is a separate behavioral decision, intentionally out of scope for this byte-preserving refactor.
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

/** FE-applied blocked carrier (shipping-provider) IDs. See APPLICATION SCOPE above. */
export const BLOCKED_CARRIER_IDS = new Set<number>([
  442017, // Amazon Buy Shipping
  566344, // Sendle
  593739, // Amazon Shipping US
]);

/** Catches flat-rate / box service names (e.g. "Priority Mail Flat Rate Envelope"). */
export const BLOCKED_NAME_RE = /flat[\s-]?rate|\bbox\b/i;

/** Stores explicitly permitted to use USPS Media Mail (overrides the media-mail block). */
export const MEDIA_MAIL_ALLOWED_STORES = new Set<number>([376759]);

/**
 * Shared core predicate: is this rate blocked by service code, package type, or service-name match?
 * This is the logic common to BOTH the backend and FE block checks. It deliberately does NOT include
 * the media-mail store exception (callers apply that as a short-circuit BEFORE this, so the exception
 * can also bypass the FE carrier check) nor the FE-only carrier-id check (callers compose that).
 */
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
