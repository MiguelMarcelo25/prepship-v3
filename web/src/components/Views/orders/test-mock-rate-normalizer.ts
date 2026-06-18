// PS-166 (this slice): buildTestMockRate + its two fallback constants
// (TEST_SERVICE_CODE / TEST_SHIPPING_ACCOUNT_LABEL) moved VERBATIM out of
// OrdersView.tsx into their own small file (DJ preference: new functions live in
// their own small file). buildTestMockRate is PURE: it normalizes a (possibly
// partial) source rate object into the synthetic test-rate shape for the local
// "PrepShip Test" carrier. No React, no state, no fetch, no side effects.
//
// IMPORTANT (architecture): this only re-shapes a SYNTHETIC test rate. It never
// reads or recomputes a real money/insurance verdict — the real best-rate truth
// is backend-owned and forwarded verbatim by the FE.
import { TEST_CARRIER_CODE } from './test-rate-mock'

export const TEST_SERVICE_CODE = 'prepship_test_standard'
export const TEST_SHIPPING_ACCOUNT_LABEL = 'PrepShip Test'

export function buildTestMockRate(source?: Record<string, unknown>) {
  const readString = (value: unknown) => typeof value === 'string' && value.trim() ? value : null
  const readNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
  const raw = source && typeof source.raw === 'object' && source.raw !== null ? source.raw as Record<string, unknown> : {}
  const shipmentCost = Math.max(0, readNumber(source?.shipmentCost) ?? readNumber(source?.amount) ?? 0)
  const otherCost = Math.max(0, readNumber(source?.otherCost) ?? 0)
  const amount = shipmentCost + otherCost
  const carrierCode = readString(source?.carrierCode) ?? TEST_CARRIER_CODE
  const serviceCode = readString(source?.serviceCode) ?? TEST_SERVICE_CODE
  const serviceName = readString(source?.serviceName) ?? readString(raw.serviceName) ?? 'PrepShip Test Standard'
  const carrierNickname = readString(source?.carrierNickname) ?? readString(raw.carrierNickname) ?? TEST_SHIPPING_ACCOUNT_LABEL
  return {
    carrierCode,
    serviceCode,
    serviceName,
    carrierNickname,
    providerAccountNickname: carrierNickname,
    shippingProviderId: null,
    providerAccountId: null,
    amount,
    cost: amount,
    shipmentCost,
    otherCost,
    raw: {
      ...raw,
      testRate: true,
      simulatedProviderId: source?.shippingProviderId ?? null,
      carrierCode,
      serviceCode,
      serviceName,
      carrierNickname,
      shipmentCost,
      otherCost,
    },
  }
}
