// PS-165: canonical owner for the per-status carrier/service DISPLAY precedence.
//
// The awaiting-vs-shipped precedence rules for the Orders carrier/service columns were inline in
// OrdersView (getCarrierCodeForDisplay / getBestRateServiceCode). They are PURE DTO-field cascades
// (no dependency on the live scoped carrier cache), so they are the safely-backend-ownable half of
// the displayShipping work. This module is the single tested home for those rules; OrdersView
// delegates to it. Callers still extract the raw fields with their existing helpers and pass them
// in as primitives — so the displayed value is byte-identical to the previous inline logic.
//
// NOT moved here (intentionally): the shipping-ACCOUNT / provider-nickname display
// (getShipAccountDisplay → getV2CarrierAccountForOrder), which depends on the live scoped carrier
// accounts the backend serializer does not have. That half stays in OrdersView until it can be
// verified against a live API. See psticketchecklist.md PS-165.
//
// Per user override `unlock shipped data` on 2026-06-10: this precedence governs how shipped/
// cancelled rows render their carrier/service columns. It is moved UNCHANGED (verbatim cascade) and
// pinned by scripts/ps-165-order-shipping-display-guard.ts. The shipped/cancelled lock is not
// weakened: no mutation path, no read-only gate, and no shipped-data write is touched here.

/** Carrier display code for a test order (mirrors OrdersView TEST_CARRIER_CODE). */
export const DISPLAY_TEST_CARRIER_CODE = 'prepship_test'

export type DisplayCarrierCodeInput = {
  /** order is a PrepShip test order (isTestOrder(order)). */
  isTest: boolean
  /** orderStatus === 'awaiting_shipment'. */
  isAwaiting: boolean
  /** toStringValue(order.bestRate?.carrierCode). */
  bestRateCarrierCode: string | null
  /** getShippingString(order, 'carrierCode') — the canonical shipping map value. */
  canonicalCarrierCode: string | null
  /** toStringValue(order.selectedRate?.carrierCode). */
  selectedRateCarrierCode: string | null
  /** getBestRateCarrierNickname(order) — only consulted on awaiting rows. */
  bestRateNickname: string | null
  /** classifyCarrier(bestRateNickname) !== 'other' — i.e. the nickname maps to a KNOWN carrier. */
  bestRateNicknameIsKnownCarrier: boolean
}

/**
 * PS-079 / PS-165 — the carrier code shown in the Orders carrier column.
 * Verbatim port of OrdersView.getCarrierCodeForDisplay:
 *  - test order                 → TEST_CARRIER_CODE
 *  - awaiting_shipment          → bestRate → canonical → selectedRate; if blank, a KNOWN-carrier
 *                                 best-rate nickname; else the (blank) carrier code
 *  - shipped / history          → canonical → selectedRate → bestRate
 */
export function resolveDisplayCarrierCode(input: DisplayCarrierCodeInput): string | null {
  if (input.isTest) return DISPLAY_TEST_CARRIER_CODE

  if (input.isAwaiting) {
    const carrierCode = input.bestRateCarrierCode ?? input.canonicalCarrierCode ?? input.selectedRateCarrierCode
    if (carrierCode) return carrierCode
    if (input.bestRateNickname && input.bestRateNicknameIsKnownCarrier) return input.bestRateNickname
    return carrierCode ?? null
  }

  if (input.canonicalCarrierCode) return input.canonicalCarrierCode
  return input.selectedRateCarrierCode ?? input.bestRateCarrierCode ?? null
}

export type DisplayServiceCodeInput = {
  /** orderStatus === 'awaiting_shipment'. */
  isAwaiting: boolean
  /** order.bestRate is present. */
  hasBestRate: boolean
  /** toStringValue(order.bestRate?.serviceCode). */
  bestRateServiceCode: string | null
  /** getShippingString(order, 'serviceCode') — the canonical shipping map value. */
  canonicalServiceCode: string | null
}

/**
 * PS-079 / PS-165 — the service code shown in the Orders service column.
 * Verbatim port of OrdersView.getBestRateServiceCode:
 *  - awaiting_shipment with a best rate → the best-rate serviceCode if present
 *  - otherwise                          → canonical serviceCode, else the best-rate serviceCode
 */
export function resolveDisplayServiceCode(input: DisplayServiceCodeInput): string | null {
  if (input.isAwaiting && input.hasBestRate && input.bestRateServiceCode) {
    return input.bestRateServiceCode
  }
  return input.canonicalServiceCode ?? (input.hasBestRate ? input.bestRateServiceCode : null)
}

/** Shipping-account display label for a test order (mirrors OrdersView TEST_SHIPPING_ACCOUNT_LABEL). */
export const DISPLAY_TEST_SHIPPING_ACCOUNT_LABEL = 'PrepShip Test'

export type DisplayShipAccountInput = {
  /** isTestOrder(order). */
  isTest: boolean
  /** awaiting + bestRate: the best-rate nickname (carrier/provider/account, or account-by-providerId). null otherwise. */
  awaitingBestRateNickname: string | null
  /** getShippingString(order,'accountNickname'), normalized. */
  canonicalNickname: string | null
  /** order.selectedRate?.providerAccountNickname, normalized. */
  selectedNickname: string | null
  /** getV2CarrierAccountForOrder(order)?.nickname — the FE scoped carrier-cache lookup. */
  v2AccountNickname: string | null
  /** order.selectedRate is present. */
  hasSelectedRate: boolean
  /** label.shippingProviderId → matched account display label. */
  labelAccountLabel: string | null
  /** order.bestRate nickname (carrier/provider/account), normalized. */
  bestRateNickname: string | null
  /** formatCarrierCode(selectedRate.carrierCode ?? bestRate.carrierCode) — final fallback. */
  carrierCodeFallback: string | null
}

/**
 * PS-165 — the Orders shipping-ACCOUNT column display precedence (the account/provider-nickname
 * resolver), ported VERBATIM from OrdersView.getShipAccountDisplay. The candidate RESOLUTION (incl.
 * the FE scoped-carrier-cache lookup and the live accounts array) necessarily stays in OrdersView —
 * the backend serializer doesn't have the live scoped carrier accounts — but the PRECEDENCE POLICY
 * now lives here (one tested place, alongside the carrier/service precedence). First-non-null cascade:
 *   test → awaiting best-rate → canonical → selected → v2-cache account → 'External' (if a selected
 *   rate exists) → label account → best-rate → formatted carrier code.
 */
export function resolveDisplayShipAccount(input: DisplayShipAccountInput): string | null {
  if (input.isTest) return DISPLAY_TEST_SHIPPING_ACCOUNT_LABEL
  if (input.awaitingBestRateNickname) return input.awaitingBestRateNickname
  if (input.canonicalNickname) return input.canonicalNickname
  if (input.selectedNickname) return input.selectedNickname
  if (input.v2AccountNickname) return input.v2AccountNickname
  if (input.hasSelectedRate) return 'External'
  if (input.labelAccountLabel) return input.labelAccountLabel
  if (input.bestRateNickname) return input.bestRateNickname
  return input.carrierCodeFallback
}
