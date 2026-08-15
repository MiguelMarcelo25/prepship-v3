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
   * PS-366: the rate this row was quoted at, which is what the Best Rate CELL shows on a
   * HUGRAB override row — see customerRateSource below. Not a fallback for
   * cShippingRateAmount; the two are used in mutually exclusive branches.
   */
  markedAmount: number | null | undefined
  /**
   * PS-366 — the backend's name for where the customer amount came from.
   *
   * Read for ONE decision only: 'hugrab_shipping_rate_override' means the customer is
   * BILLED an overridden amount (cShippingRateAmount) while the cell shows the RATE
   * (markedAmount). That is a product rule with its own guard, not a fallback: billed
   * money and displayed rate are different facts for those rows.
   */
  customerRateSource?: string | null | undefined
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

  // An explicit BRANCH on a backend-stated source, not a precedence chain.
  //
  // PS-366: when the HUGRAB override applies, cShippingRateAmount is what the customer is
  // BILLED and markedAmount is the rate the row was quoted at — and the Best Rate cell
  // shows the rate. Those are two different facts about one row, so selecting between them
  // by a backend-stated source is a rule; reaching for whichever is non-null would be the
  // substitution this ticket removes. The backend decides WHICH field applies here; it is
  // not a frontend guess, and only these two customer-side fields are ever candidates —
  // selectedRateCost and baseAmount remain unreachable as a customer price.
  const isHugrabOverride = input.customerRateSource === 'hugrab_shipping_rate_override'
  const customerAmount = isHugrabOverride
    ? finiteAmount(input.markedAmount)
    : finiteAmount(input.cShippingRateAmount)

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
