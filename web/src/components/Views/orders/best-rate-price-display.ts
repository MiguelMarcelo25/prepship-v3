/**
 * PS-499 — the Best Rate cell's price display, over a backend-stated contract.
 *
 * WHAT WAS WRONG
 *
 * This resolved the displayed amount by precedence:
 *
 *   purchaseAmount = selectedRateCost ?? baseAmount
 *   customerAmount = cShippingRateAmount ?? markedAmount ?? purchaseAmount ?? fallbackAmount
 *   primaryAmount  = customerAmount ?? purchaseAmount ?? fallbackAmount
 *
 * Four DIFFERENT money meanings collapsed by position: what we paid
 * (selectedRateCost), the carrier's base (baseAmount / fallbackAmount, both call sites
 * passed bestRateBaseCost), the customer-billed amount (cShippingRateAmount) and the
 * marked-up amount (markedAmount). When the customer amount was absent the cell rendered
 * a purchase or base figure — real money, plausibly sized, under a customer-price label,
 * with nothing marking the substitution. That is the defect PS-499 exists to remove.
 *
 * WHAT REPLACES IT
 *
 * The backend states whether a customer amount exists (`customerAmountState`, stamped in
 * rate-money.ts beside the customerRateSource that already names its provenance). This
 * renders that verdict:
 *
 *   available    → cShippingRateAmount, the canonical customer amount
 *   unavailable  → mode 'customer_amount_unavailable' and a NULL primaryAmount
 *
 * There is no fallback rung. A caller that cannot show a customer price shows that it
 * cannot, which is recoverable; showing the wrong number confidently is not.
 *
 * The purchase amount is still returned, because the house and breakdown modes legitimately
 * display it — but under its own name, never as the customer price.
 */

export type AwaitingBestRateMarkupSource = 'house_account' | 'carrier_markup'

/** PS-499: mirrors OrderRowMoneyDisplay['customerAmountState'] from the backend tuple. */
export type AwaitingBestRateCustomerAmountState = 'available' | 'unavailable'

export type AwaitingBestRatePriceDisplayInput = {
  markupSource: AwaitingBestRateMarkupSource
  selectedRateCost: number | null | undefined
  baseAmount: number | null | undefined
  cShippingRateAmount: number | null | undefined
  insuranceAddOn: number | null | undefined
  /**
   * The backend's verdict on whether a customer amount exists.
   *
   * Optional ONLY for deploy skew — an older backend omits it. Absent is treated as
   * 'available' when a customer amount is actually present and 'unavailable' otherwise,
   * which is the same answer the field would carry, so skew degrades to the truth rather
   * than to a substitution.
   */
  customerAmountState?: AwaitingBestRateCustomerAmountState | null | undefined
}

export type AwaitingBestRatePriceDisplay = {
  mode:
    | 'house_purchase_only'
    | 'carrier_marked_breakdown'
    | 'single_amount'
    | 'customer_amount_unavailable'
  primaryAmount: number | null
  baseAmount: number | null
  insuranceAddOn: number | null
  showHouseBadge: boolean
}

function finiteAmount(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function hasVisibleMarkup(baseAmount: number | null, primaryAmount: number | null) {
  return baseAmount != null && primaryAmount != null && primaryAmount - baseAmount >= 0.005
}

export function resolveAwaitingBestRatePriceDisplay(
  input: AwaitingBestRatePriceDisplayInput,
): AwaitingBestRatePriceDisplay {
  // Still a two-field read, but both are COST fields and the result is only ever shown as
  // a cost — as the house purchase figure, or as the base under a marked breakdown.
  const purchaseAmount = finiteAmount(input.selectedRateCost) ?? finiteAmount(input.baseAmount)
  const customerAmount = finiteAmount(input.cShippingRateAmount)

  // Deploy skew only: an older backend omits the field, so the presence of the amount is
  // the same verdict the backend would have sent.
  const state: AwaitingBestRateCustomerAmountState =
    input.customerAmountState ?? (customerAmount != null ? 'available' : 'unavailable')

  if (input.markupSource === 'house_account') {
    // A house row shows DJR's purchase cost by design — that is its own meaning, not a
    // stand-in for a customer price, so it does not depend on customerAmountState.
    return {
      mode: 'house_purchase_only',
      primaryAmount: purchaseAmount,
      baseAmount: null,
      insuranceAddOn: null,
      showHouseBadge: true,
    }
  }

  if (state !== 'available' || customerAmount == null) {
    return {
      mode: 'customer_amount_unavailable',
      primaryAmount: null,
      baseAmount: null,
      insuranceAddOn: finiteAmount(input.insuranceAddOn),
      showHouseBadge: false,
    }
  }

  const canShowBreakdown = hasVisibleMarkup(purchaseAmount, customerAmount)

  return {
    mode: canShowBreakdown ? 'carrier_marked_breakdown' : 'single_amount',
    primaryAmount: customerAmount,
    baseAmount: canShowBreakdown ? purchaseAmount : null,
    insuranceAddOn: finiteAmount(input.insuranceAddOn),
    showHouseBadge: false,
  }
}
