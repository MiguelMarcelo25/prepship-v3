export type AwaitingBestRateMarkupSource = 'house_account' | 'carrier_markup'

export type AwaitingBestRatePriceDisplayInput = {
  markupSource: AwaitingBestRateMarkupSource
  rateCostAmount: number | null | undefined
  baseAmount: number | null | undefined
  customerRateAmount: number | null | undefined
  markedAmount: number | null | undefined
  insuranceAddOn: number | null | undefined
  fallbackAmount: number | null | undefined
}

export type AwaitingBestRatePriceDisplay = {
  mode: 'house_purchase_only' | 'carrier_marked_breakdown' | 'single_amount'
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
  const purchaseAmount = finiteAmount(input.rateCostAmount) ?? finiteAmount(input.baseAmount)
  const customerAmount =
    finiteAmount(input.customerRateAmount) ??
    finiteAmount(input.markedAmount) ??
    purchaseAmount ??
    finiteAmount(input.fallbackAmount)

  if (input.markupSource === 'house_account') {
    return {
      mode: 'house_purchase_only',
      primaryAmount: purchaseAmount ?? customerAmount,
      baseAmount: null,
      insuranceAddOn: null,
      showHouseBadge: true,
    }
  }

  const primaryAmount = customerAmount ?? purchaseAmount ?? finiteAmount(input.fallbackAmount)
  const canShowBreakdown = hasVisibleMarkup(purchaseAmount, primaryAmount)

  return {
    mode: canShowBreakdown ? 'carrier_marked_breakdown' : 'single_amount',
    primaryAmount,
    baseAmount: canShowBreakdown ? purchaseAmount : null,
    insuranceAddOn: finiteAmount(input.insuranceAddOn),
    showHouseBadge: false,
  }
}
