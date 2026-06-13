// PS-166 (Wave 1d): OrdersView's rate-input normalizers, moved VERBATIM out
// of OrdersView.tsx (module-level pure helpers — no hooks, no JSX, no
// behavior change). Strict TypeScript. PS-164's delegation contract is
// unchanged and its guard pins these definition shapes HERE: the FE owns no
// alias maps — confirmation/insurance normalization delegates to the single
// canonical owner (src/lib/shipping-options).
import { normalizeConfirmation, normalizeInsurance } from '../../../../src/lib/shipping-options'

// POLICY (DJ, 2026-06-04): confirmation DEFAULTS TO 'none' so PrepShip rates
// match ShipStation's no-confirmation quote out of the box. 'none' is a real,
// selectable option; the operator can opt into Delivery/Signature per order.
// PS-164: delegate to the canonical confirmation normalizer (single alias owner). For the 5 UI
// dropdown values this is identical to the previous hand-rolled allowlist; it additionally honors
// the backend's confirmation aliases instead of silently downgrading them to 'none'.
export function normalizeConfirmationForRates(value: string | null | undefined) {
  return normalizeConfirmation(value)
}

// PS-072: infer carrier from a service code so resolveEffectiveInsurance can
// apply the ParcelGuard defaults to UPS/USPS ground services.
export function inferCarrierFromServiceCode(serviceCode: string | null | undefined): string {
  const s = String(serviceCode ?? '').toLowerCase()
  if (s.includes('usps') || s.includes('stamps') || s.includes('ground_advantage') || s.includes('groundadvantage') || s.includes('parcel_select')) return 'usps'
  if (s.includes('ups')) return 'ups'
  return ''
}

// PS-164: delegate to the canonical insurance normalizer (single alias owner). It preserves
// 'shipsurance'/'parcelguard' (incl. the parcel_guard / "parcel guard" aliases) and maps
// carrier/provider/shipstation -> 'carrier'. Behavior change (DJ-approved 2026-06-10): an UNKNOWN
// provider now resolves to 'none' (no insurance) instead of silently charging 'carrier' insurance —
// the same money-truth the backend label path already uses. Needs a live insurance spot-check.
export function normalizeInsuranceForRates(provider: string | null | undefined, value: string | number | null | undefined) {
  return normalizeInsurance({ insuranceProvider: provider, insuredValue: value })
}
