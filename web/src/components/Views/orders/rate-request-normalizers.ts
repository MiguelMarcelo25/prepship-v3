// PS-166 (this slice): the two pure rate-request key normalizers
// (normalizeRateZip + rateShipDateBucket) moved VERBATIM out of OrdersView.tsx
// into the orders/ package directory (DJ preference: new functions live in their
// own small file). These are PURE — every output depends only on the arguments
// (rateShipDateBucket defaults to `new Date()`, which is the only ambient input).
// No React, no component state, no refs, no fetch, no side effects.
//
// They are the FE-side input normalizers that feed buildRateRequestDraftKey's
// local cache-match key. buildRateRequestDraftKey itself STAYS in OrdersView and
// keeps owning the FE draft key — PS-143: the FE draft key must remain independent
// of the backend response fingerprint, and these normalizers are pure input
// shaping (postal + ship-date bucket), not derived from any backend fingerprint.

import { toStringValue } from '../orders-row-display'

// PS-126: preserve the EXACT postal (US ZIP+4) in the draft request key so the
// frontend cache-match key matches the backend's exact-postal fingerprint. ZIP5-only
// orders are unchanged. Backend proof/fingerprint stays authoritative.
export function normalizeRateZip(value: unknown) {
  const raw = (toStringValue(value) ?? '').trim()
  if (!raw) return ''
  if (/[^0-9-]/.test(raw)) return raw.toUpperCase()
  const digits = raw.replace(/\D/g, '')
  if (digits.length >= 9) return `${digits.slice(0, 5)}-${digits.slice(5, 9)}`
  if (digits.length >= 5) return digits.slice(0, 5)
  return digits || raw.toUpperCase()
}

export function rateShipDateBucket(date = new Date()) {
  return date.toISOString().slice(0, 10)
}
