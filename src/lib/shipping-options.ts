export type NormalizedConfirmation =
  | 'none'
  | 'delivery'
  | 'signature'
  | 'adult_signature'
  | 'direct_signature'
  | 'delivery_mailed'
  | 'verbal_confirmation'
  | 'delivery_code'
  | 'age_verification_16_plus';

export type NormalizedInsuranceProvider = 'none' | 'carrier' | 'shipsurance' | 'parcelguard';

export type NormalizedShippingOptions = {
  confirmation: NormalizedConfirmation;
  insuranceProvider: NormalizedInsuranceProvider;
  insuredValue: number | null;
};

const CONFIRMATION_ALIASES = new Map<string, NormalizedConfirmation>([
  ['none', 'none'],
  ['no_confirmation', 'none'],
  ['delivery', 'delivery'],
  ['delivery_confirmation', 'delivery'],
  ['signature', 'signature'],
  ['signature_confirmation', 'signature'],
  ['adult_signature', 'adult_signature'],
  ['adult signature', 'adult_signature'],
  ['direct_signature', 'direct_signature'],
  ['direct signature', 'direct_signature'],
  ['delivery_mailed', 'delivery_mailed'],
  ['verbal_confirmation', 'verbal_confirmation'],
  ['delivery_code', 'delivery_code'],
  ['age_verification_16_plus', 'age_verification_16_plus'],
]);

const INSURANCE_ALIASES = new Map<string, NormalizedInsuranceProvider>([
  ['none', 'none'],
  ['no', 'none'],
  ['false', 'none'],
  ['carrier', 'carrier'],
  ['provider', 'carrier'],
  ['shipstation', 'carrier'],
  ['shipsurance', 'shipsurance'],
  // PS-072: ShipStation Parcel Guard (third-party). Must map to itself and
  // survive re-normalization (normalizeShippingOptions runs twice on the label
  // path), so it can never silently collapse to 'none' or 'carrier'.
  ['parcelguard', 'parcelguard'],
  ['parcel_guard', 'parcelguard'],
  ['parcel guard', 'parcelguard'],
]);

function normalizedKey(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

// POLICY (DJ, 2026-06-04): the system-wide default confirmation is 'none' (no
// confirmation surcharge — matches ShipStation's default quote). Any path that
// does not explicitly pass a confirmation now falls through to 'none'; callers
// that need a different default pass an explicit `fallback`. Operators opt into
// Delivery/Signature/Adult/Direct per order.
export function normalizeConfirmation(value?: unknown, fallback: NormalizedConfirmation = 'none') {
  if (value == null || String(value).trim() === '') return fallback;
  return CONFIRMATION_ALIASES.get(normalizedKey(value).replace(/[\s-]+/g, '_')) ??
    CONFIRMATION_ALIASES.get(normalizedKey(value)) ??
    fallback;
}

export function normalizeInsurance(input?: {
  insuranceProvider?: unknown;
  insurance?: unknown;
  insuredValue?: unknown;
  insuranceValue?: unknown;
}): Pick<NormalizedShippingOptions, 'insuranceProvider' | 'insuredValue'> {
  const provider = INSURANCE_ALIASES.get(normalizedKey(input?.insuranceProvider ?? input?.insurance)) ?? 'none';
  const rawValue = input?.insuredValue ?? input?.insuranceValue;
  const value = rawValue == null || rawValue === '' ? null : Number(rawValue);
  const insuredValue = value != null && Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : null;
  return {
    insuranceProvider: insuredValue && provider !== 'none' ? provider : 'none',
    insuredValue: insuredValue && provider !== 'none' ? insuredValue : null,
  };
}

export function normalizeShippingOptions(input?: {
  confirmation?: unknown;
  signature?: unknown;
  insuranceProvider?: unknown;
  insurance?: unknown;
  insuredValue?: unknown;
  insuranceValue?: unknown;
}): NormalizedShippingOptions {
  const insurance = normalizeInsurance(input);
  return {
    confirmation: normalizeConfirmation(input?.confirmation ?? input?.signature),
    ...insurance,
  };
}
