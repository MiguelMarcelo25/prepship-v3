// PS-166/PS-306/PS-258 (Wave 2): OrderCells — the four leaf cell renderers
// (Best Rate / Ship Margin / Carrier / Shipping Account) extracted VERBATIM out
// of OrdersView's renderTableCell. renderTableCell stays in the shell as a thin
// dispatcher that delegates to these leaves.
//
// DISPLAY-ONLY (PS-306): every renderer READS the backend money DTO
// (getBackendRowMoney via ./orders-row-display) and the backend rate/coverage
// verdicts that the injected closures resolve — it NEVER recomputes cost/margin,
// NEVER calls apiClient, and NEVER owns backend truth. The customer/house markup,
// margin %, and insurance-coverage decisions all arrive pre-computed on the DTO;
// these cells only format and place them. Behavior-identical to the prior inline
// cells (same JSX, same branch order, same byte output → the orders-dom-parity
// browser net stays 2/2).
//
// Component-scoped closures that the leaves close over in OrdersView
// (getOrderWithAutoBestRate / orderShippingHold / renderAwaitingRateFallback /
// hasDisplayableBestRateForCurrentRequest / getAwaitingBestRateDisplayState /
// getRateBaseAmount) plus the shippingAccounts list are INJECTED via the typed
// OrderCellsDeps second arg (the DI pattern used by orders-filtered-sort /
// orders-rate-cells), so this stays a leaf with no React state of its own.
import type { ReactNode } from 'react'
import { Flag, Loader2 } from 'lucide-react'
import CarrierBadge from '../../../CarrierBadge'
import type { CarrierAccountDto, OrderSummaryDto } from '../../../../types/api'
import {
  getCanonicalRecord,
  toRecord,
  toStringValue,
  toNumberValue,
  formatMoney,
  normalizeShippingAccountName,
  getBestRateBaseCost,
  getBestRateServiceCode,
  getSelectedRateBaseCost,
  getSelectedRateFinalCost,
  getBackendInsuranceAddOn,
  getBackendRowMoney,
  renderRateAmountWithMarkup,
  getBestRateInsuranceCoverage,
  getRowInsuranceCoverage,
  renderExtLabelBadge,
  renderVoidedLabelBadge,
  renderShipmentSyncErrorBadge,
  renderBundleChildBadge,
  renderHouseBadge,
} from '../../orders-row-display'
import type { OrderBundleDto } from '../use-order-bundles'
import { AWAITING_BEST_RATE_STATE_LABELS, type AwaitingBestRateDisplayState } from '../../awaiting-best-rate-display-state'
import { PENDING_RATING_WATCHDOG_MS } from '../../orders-parity'
import { isTestOrder } from '../../orders-items'
import {
  getCarrierCodeForDisplay,
  getIsExternallyFulfilled,
  getIsMissingShipmentSync,
  getIsVoidedLabel,
  getShipAccountDisplay,
  getShippedDisplayCarrierCode,
  getShippedDisplayServiceCode,
  shouldShowCarrierExtLabel,
} from '../../orders-display-state'
import { formatServiceCode, truncate } from '../../orders-formatting'
import { TEST_SHIPPING_ACCOUNT_LABEL } from '../test-mock-rate-normalizer'
import { resolveAwaitingBestRatePriceDisplay } from '../best-rate-price-display'

/**
 * The component-scoped closures + state the four leaf renderers read in
 * OrdersView. Injected (not imported) because they close over component state
 * (autoBestRateEntries / orderDetailsById / batchRecalculateRows / etc.) — they
 * are passed in already bound, so these leaves never touch React state directly.
 */
export interface OrderCellsDeps {
  getOrderWithAutoBestRate: (order: OrderSummaryDto) => OrderSummaryDto
  orderShippingHold: (order: any) => { blocked: boolean; reason: string; status: string } | null
  renderAwaitingRateFallback: (
    order: OrderSummaryDto,
    displayOrder: OrderSummaryDto,
    variant: 'full' | 'compact',
  ) => ReactNode
  hasDisplayableBestRateForCurrentRequest: (order: OrderSummaryDto) => boolean
  getAwaitingBestRateDisplayState: (order: OrderSummaryDto) => AwaitingBestRateDisplayState
  getRateBaseAmount: (rate: Record<string, unknown>) => number
  renderRateRecalculateHealth?: (order: OrderSummaryDto) => ReactNode
  shippingAccounts: CarrierAccountDto[]
  // PS-312/PS-317 (S4): combined-shipment bundle state per order id (from the backend read-model).
  // Optional so callers/tests that don't pass it keep the prior behavior exactly.
  bundleByOrderId?: Map<number, OrderBundleDto>
}

function normalizeDestinationCountry(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw.toUpperCase() || 'US'
}

function isDomesticDestination(country: string): boolean {
  const normalized = normalizeDestinationCountry(country)
  return normalized === 'US' || normalized === 'USA' || normalized === 'UNITED STATES' || normalized === 'UNITED STATES OF AMERICA'
}

function getDestinationCountry(order: OrderSummaryDto): string {
  const recipient = getCanonicalRecord(order, 'recipient')
  const shipTo = toRecord(order.shipTo)
  const raw = toRecord(order.raw)
  const rawShipTo = toRecord(raw?.shipTo)
  return normalizeDestinationCountry(
    recipient?.country ??
    shipTo?.country ??
    rawShipTo?.country ??
    rawShipTo?.countryCode ??
    rawShipTo?.country_code,
  )
}

function renderInternationalDestinationMarker(order: OrderSummaryDto): ReactNode {
  const country = getDestinationCountry(order)
  if (isDomesticDestination(country)) return null
  const displayCountry = country.length <= 3 ? country : 'INTL'
  return (
    <div
      title={`International destination: ${country}`}
      aria-label={`International destination ${country}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 1, color: 'var(--ss-blue)', fontSize: 9, fontWeight: 800, lineHeight: 1 }}
    >
      <span
        aria-hidden
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 13, height: 11, border: '1px solid var(--ss-blue-border)', borderRadius: 2, background: 'var(--surface)', color: 'var(--ss-blue)' }}
      >
        <Flag size={9} strokeWidth={2.7} />
      </span>
      <span>{displayCountry}</span>
    </div>
  )
}

function renderServiceLabelWithDestination(order: OrderSummaryDto, serviceLabel: string): ReactNode {
  return (
    <>
      <div style={{ fontSize: 10, color: 'var(--text3)' }} className="svc-label">
        {serviceLabel}
      </div>
      {renderInternationalDestinationMarker(order)}
    </>
  )
}

export function renderBestRatePrice(order: OrderSummaryDto, deps: OrderCellsDeps): ReactNode {
  const {
    getOrderWithAutoBestRate,
    orderShippingHold,
    renderAwaitingRateFallback,
    hasDisplayableBestRateForCurrentRequest,
    getAwaitingBestRateDisplayState,
  } = deps
  const displayOrder = getOrderWithAutoBestRate(order)


  if (isTestOrder(displayOrder)) {
    const testAmount = displayOrder.bestRate
      ? (toNumberValue((displayOrder.bestRate as any).shipmentCost) ?? 0) + (toNumberValue((displayOrder.bestRate as any).otherCost) ?? 0)
      : 0
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="carrier-badge" style={{ fontSize: 9.5, padding: '1px 5px', background: '#f59e0b', color: '#fff' }}>
          TEST
        </span>
        <strong style={{ color: 'var(--green)', fontSize: 12 }}>{formatMoney(testAmount)}</strong>
      </div>
    )
  }

  // PS-128/PS-129: held awaiting order (cancelled upstream / externally shipped). Show a
  // hold pill instead of a rate — the order is not normal awaiting work and the
  // label/queue/print paths are hard-blocked by the backend.
  const rowHold = orderShippingHold(displayOrder)
  if (displayOrder.orderStatus === 'awaiting_shipment' && rowHold?.blocked) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-danger-bg text-danger ring-1 ring-danger-border/40"
        title={`${rowHold.status} — ${rowHold.reason}`}
      >
        ⛔ {rowHold.status}
      </span>
    )
  }

  const bestRateBaseCost = getBestRateBaseCost(displayOrder)
  if (displayOrder.orderStatus !== 'awaiting_shipment') {
    // PS-309 (Per user override unlock shipped data on 2026-06-23): a voided-only shipped
    // label reads as "Voided label" (backend verdict) — never "Ext. Label" and never the
    // row's normal cost. Branch it before every other shipped state.
    if (getIsVoidedLabel(displayOrder)) {
      return renderVoidedLabelBadge()
    }
    if (getIsExternallyFulfilled(displayOrder)) {
      return renderExtLabelBadge()
    }
    if (getIsMissingShipmentSync(displayOrder)) {
      return renderShipmentSyncErrorBadge()
    }

    const selectedRateBase = getSelectedRateBaseCost(displayOrder)
    const labelCost = getSelectedRateFinalCost(displayOrder)
    if (selectedRateBase == null && labelCost == null) {
      return <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>
    }

    // Shipped-row DTO phase: shipped rows now carry the backend money tuple
    // (priced from the SELECTED rate by the same canonical markup rules) —
    // the FE's LAST markup-math call is deleted. A row without the tuple
    // degrades to the plain final label cost / carrier base, never
    // FE-computed markup.
    // PS — Selected Rate shows only the amount. The carrier badge lives
    // solely in the dedicated Carrier column; duplicating it here was noisy.
    const shippedBackendMoney = getBackendRowMoney(displayOrder)
    if (shippedBackendMoney) {
      // PS-220 (slice 4b-2): a realized SHIPP house order shows the customer_rate billed + a HOUSE badge.
      if (shippedBackendMoney.markupSource === 'house_account') {
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* PS-290 parity: same backend coverage verdict on the Selected Rate cell. */}
            {renderRateAmountWithMarkup(null, shippedBackendMoney.markedAmount, shippedBackendMoney.insuranceAddOn, getRowInsuranceCoverage(displayOrder.selectedRate))}
            {renderHouseBadge()}
          </div>
        )
      }
      return renderRateAmountWithMarkup(shippedBackendMoney.baseAmount, shippedBackendMoney.markedAmount, shippedBackendMoney.insuranceAddOn, getRowInsuranceCoverage(displayOrder.selectedRate))
    }
    return renderRateAmountWithMarkup(selectedRateBase, labelCost ?? selectedRateBase, getBackendInsuranceAddOn(displayOrder.selectedRate), getRowInsuranceCoverage(displayOrder.selectedRate))
  }

  const awaitingFallback = renderAwaitingRateFallback(order, displayOrder, 'full')
  if (awaitingFallback) return awaitingFallback

  const hasDisplayableBestRate = hasDisplayableBestRateForCurrentRequest(displayOrder)
  // PS-499: was `bestRateBaseCost == null`. That term was only ever true when the money
  // tuple was ABSENT — getBackendRowMoney returns null unless markedAmount exists, so the
  // old four-rung chain could not be null while a tuple existed. Now that the cost getter
  // is cost-only, the same expression would ALSO be true for a row that has a customer
  // amount but no cost, quietly hiding it behind the awaiting fallback. Asking about the
  // tuple directly says what was always meant and is exactly equivalent to the original.
  if (!hasDisplayableBestRate || getBackendRowMoney(displayOrder) == null) {
    // Per user override unlock shipped data on 2026-05-23: extended by DJ's current 2026-06-03 override; Best Rate uses the same bounded/actionable awaiting-rate fallback as Carrier/Margin so it cannot stay visually stuck until Browse Rates is clicked.
    // PS-286: when the row HAS a saved best rate that no longer satisfies the
    // backend display contract, render the SPECIFIC actionable reason (Rate
    // expired / Carrier coverage incomplete / Recalculate required) instead of a
    // bare dash that reads like a missing rate. The dollar figure is suppressed
    // because the saved rate is stale — the operator must re-rate.
    const sotState = getAwaitingBestRateDisplayState(displayOrder)
    const sotLabel = AWAITING_BEST_RATE_STATE_LABELS[sotState]
    if (sotLabel) {
      return (
        <span
          data-rate-state={`sot-${sotState}`}
          title={`${sotLabel} — the saved best rate is no longer valid for the current request; re-rate this order.`}
          style={{ color: 'var(--text3)', fontSize: 10.5, whiteSpace: 'nowrap' }}
        >
          {sotLabel}
        </span>
      )
    }
    return <span style={{ color: 'var(--text3)', fontSize: 11 }}>--</span>
  }
  // Recalculate-in-flight indicator: the backfill stamps pending/rating on the
  // row's rate job (PS-120) while Recalculate All re-rates it. Keep showing the
  // saved amount (PS-196 — never wipe a displayable value) but spin beside it so
  // the operator SEES the recalculation; the fresh best rate replaces it on the
  // next mid-job row refresh. Bounded by the same watchdog the rate-state
  // classifier uses, so a stuck job can never spin forever.
  const rowWorkflowRecord = toRecord((displayOrder as any).bestRateWorkflow)
  const rowRateJobState =
    toStringValue(rowWorkflowRecord?.activeRateCheckState) ??
    toStringValue(rowWorkflowRecord?.bestRateState)
  const rowRateJobAgeMs =
    toNumberValue(rowWorkflowRecord?.activeRateCheckAgeMs) ??
    toNumberValue(rowWorkflowRecord?.bestRateStateAgeMs)
  const isRowRecalculating =
    (rowRateJobState === 'pending' || rowRateJobState === 'rating') &&
    (rowRateJobAgeMs == null || rowRateJobAgeMs <= PENDING_RATING_WATCHDOG_MS)
  const recalculatingSpinner = isRowRecalculating ? (
    <span title="Recalculating — fetching live rates from all carriers" className="inline-flex shrink-0">
      <Loader2 size={12} className="animate-spin text-brand" aria-hidden />
    </span>
  ) : null

  // PS-357: Best Rate display is presentation-only over the backend money tuple.
  // HOUSE rows show DJR purchase cost once; marked carrier rows may show a breakdown.
  // Operator request (2026-05-12, under `unlock shipped data` override): no
  // per-carrier SVG badge in this cell — the Carrier column already shows it.
  const backendMoney = getBackendRowMoney(displayOrder)
  const bestRatePriceDisplay = backendMoney
    ? resolveAwaitingBestRatePriceDisplay({
      markupSource: backendMoney.markupSource,
      selectedRateCost: backendMoney.selectedRateCost,
      baseAmount: backendMoney.baseAmount,
      cShippingRateAmount: backendMoney.cShippingRateAmount,
      insuranceAddOn: backendMoney.insuranceAddOn,
      // PS-499: markedAmount, fallbackAmount (bestRateBaseCost) and the customerRateSource
      // branch are gone. They existed to feed a precedence chain that substituted a
      // purchase or base figure when the customer amount was absent; the backend now
      // states whether one exists and the cell renders that verdict.
      markedAmount: backendMoney.markedAmount,
      customerRateSource: backendMoney.customerRateSource,
      customerAmountState: backendMoney.customerAmountState,
    })
    : null
  return (
    <div data-rate-state="ready" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {/* PS-290: pass the backend-owned HUGRAB $100 coverage verdict as the 4th arg so the
          Awaiting Best Rate cell renders the coverage badge (display-only; backend decides). */}
      {bestRatePriceDisplay
        ? renderRateAmountWithMarkup(
          bestRatePriceDisplay.baseAmount,
          bestRatePriceDisplay.primaryAmount,
          bestRatePriceDisplay.insuranceAddOn,
          // The HOUSE badge is a pricing marker, not an insurance verdict. Keep
          // rendering the backend-owned HUGRAB coverage badge on Shipp/house rows.
          getBestRateInsuranceCoverage(displayOrder),
        )
        // PS-499 AC-2: no backend money tuple means there is no customer amount for this
        // row. This previously rendered `(bestRateBaseCost, bestRateBaseCost, …)` — the
        // carrier's BASE COST passed as the customer amount as well as the base, so the
        // cell showed a real, plausibly-sized number under a customer-price label whenever
        // the customer amount was missing. Nulls render "—"; the insurance add-on and the
        // backend coverage verdict still show, because those are unaffected by the absence
        // of a customer price.
        : renderRateAmountWithMarkup(null, null, getBackendInsuranceAddOn(displayOrder.bestRate), getBestRateInsuranceCoverage(displayOrder))}
      {recalculatingSpinner}
      </div>
      {/* PS-357: HOUSE remains a backend verdict marker, but sits under the single purchase-cost rate. */}
      {bestRatePriceDisplay?.showHouseBadge ? renderHouseBadge() : null}
      {deps.renderRateRecalculateHealth?.(order)}
    </div>
  )
}

export function renderMargin(order: OrderSummaryDto, deps: OrderCellsDeps): ReactNode {
  const { getOrderWithAutoBestRate, renderAwaitingRateFallback } = deps
  if (isTestOrder(order)) {
    return <span style={{ color: 'var(--text4)', fontSize: 11 }}>{'—'}</span>
  }

  const isAwaiting = order.orderStatus === 'awaiting_shipment'
  const displayOrder = isAwaiting ? getOrderWithAutoBestRate(order) : order
  if (isAwaiting) {
    // PS-071 — consume the SAME auto-best-rate source as the Carrier / Shipping
    // Account / Best Rate cells, so a rate found by passive auto-rating updates
    // Margin too instead of leaving it spinning until a manual refetch.
    const bestRateBaseCost = getBestRateBaseCost(displayOrder)
    if (!displayOrder.bestRate || bestRateBaseCost == null) {
      // Bounded/terminal fallback (compact) instead of an indefinite spinner.
      return renderAwaitingRateFallback(order, displayOrder, 'compact')
        ?? <span style={{ color: 'var(--text4)', fontSize: 11 }}>—</span>
    }
  }

  // Per user override unlock shipped data on 2026-07-16: shipped rows now display the
  // backend-issued realized shipping margin; this is presentation-only and performs no mutation.
  // The BACKEND money tuple is the only source. A row without the tuple shows a dash;
  // the FE never recomputes customer shipping charge minus selected/purchased cost.
  const backendMoney = getBackendRowMoney(displayOrder)
  const diff = backendMoney?.shippingMarginAmount
  if (diff == null) return <span style={{ color: 'var(--text4)', fontSize: 11 }}>—</span>
  const amountClass = diff > 0.005 ? 'text-ok' : diff < -0.005 ? 'text-danger' : 'text-ink-2'
  return (
    <div style={{ lineHeight: 1.3, textAlign: 'left' }}>
      <div className={amountClass} style={{ fontSize: 12, fontWeight: 700 }}>{diff > 0.005 ? '+' : ''}{formatMoney(diff)}</div>
      {backendMoney?.shippingMarginPct != null
        ? <div style={{ fontSize: 10, color: 'var(--text3)' }}>{backendMoney.shippingMarginPct}%</div>
        : null}
    </div>
  )
}

export function renderCarrierCell(order: OrderSummaryDto, deps: OrderCellsDeps): ReactNode {
  const { getOrderWithAutoBestRate, renderAwaitingRateFallback } = deps
  const displayOrder = getOrderWithAutoBestRate(order)

  if (isTestOrder(displayOrder)) {
    return (
      <span
        className="carrier-badge"
        style={{ background: '#f59e0b', color: '#fff' }}
        title="Test order: mock carrier only, no real postage"
      >
        TEST
      </span>
    )
  }

  const shipped = displayOrder.orderStatus !== 'awaiting_shipment'
  if (shipped) {
    // PS-309: voided label wins over ext / missing / carrier (backend verdict).
    if (getIsVoidedLabel(displayOrder)) {
      return renderVoidedLabelBadge()
    }
    if (shouldShowCarrierExtLabel(displayOrder)) {
      return renderExtLabelBadge()
    }
    if (getIsMissingShipmentSync(displayOrder)) {
      // PS-312/PS-317 (S4): a combined-shipment bundle CHILD has no own label (the bundle PRIMARY
      // carries the ONE label), so it falls into this "no local shipment" branch. Resolve it to the
      // bundle's shared shipment instead of the sync-error dead-end. Backend-owned DTO, rendered verbatim.
      const bundle = deps.bundleByOrderId?.get(order.orderId)
      if (bundle && bundle.role === 'child') {
        return renderBundleChildBadge(bundle)
      }
      return renderShipmentSyncErrorBadge()
    }

    const carrierCode = getShippedDisplayCarrierCode(displayOrder)
    if (!carrierCode) {
      return <span style={{ color: 'var(--text4)', fontSize: 11 }}>{'—'}</span>
    }

    return (
      <div style={{ display: 'flex', alignItems: 'center', lineHeight: 1.3 }}>
        <CarrierBadge code={carrierCode} size="sm" />
      </div>
    )
  }

  // PS-312/PS-317 (S4): an AWAITING combined-shipment CHILD ships under the bundle PRIMARY's single
  // label, so it has no own rate to buy — surface its bundle membership (shared shipment) instead of a
  // rate, so a freshly-combined order shows it's bundled immediately, not just once shipped.
  const childBundle = deps.bundleByOrderId?.get(order.orderId)
  if (childBundle && childBundle.role === 'child') {
    return renderBundleChildBadge(childBundle)
  }

  // PS-071 — bounded/actionable state instead of an indefinite spinner.
  const fallback = renderAwaitingRateFallback(order, displayOrder, 'full')
  if (fallback) return fallback

  // Keep carrier logos readable in the Orders table. Awaiting, shipped,
  // and cancelled rows all share this renderer.
  return (
    <div
      data-rate-state="ready"
      style={{ display: 'flex', alignItems: 'center', lineHeight: 1.3 }}
    >
      <CarrierBadge code={getCarrierCodeForDisplay(displayOrder) ?? ''} size="sm" />
    </div>
  )
}

export function renderShippingAccountCell(order: OrderSummaryDto, deps: OrderCellsDeps): ReactNode {
  const { getOrderWithAutoBestRate, renderAwaitingRateFallback, shippingAccounts } = deps
  const displayOrder = getOrderWithAutoBestRate(order)

  if (isTestOrder(displayOrder)) {
    const testAccount = normalizeShippingAccountName((displayOrder.bestRate as any)?.carrierNickname) ?? TEST_SHIPPING_ACCOUNT_LABEL
    return (
      <div style={{ lineHeight: 1.4, whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#b45309' }}>{testAccount}</div>
        <div style={{ fontSize: 10, color: 'var(--text3)' }} className="svc-label">
          test mock - no real postage
        </div>
      </div>
    )
  }

  const shipped = displayOrder.orderStatus !== 'awaiting_shipment'
  if (shipped) {
    // PS-309: voided label wins over ext / missing / account (backend verdict).
    if (getIsVoidedLabel(displayOrder)) {
      return renderVoidedLabelBadge()
    }
    if (getIsExternallyFulfilled(displayOrder)) {
      return renderExtLabelBadge()
    }
    if (getIsMissingShipmentSync(displayOrder)) {
      return renderShipmentSyncErrorBadge()
    }

    const accountDisplay = getShipAccountDisplay(displayOrder, shippingAccounts)
    if (!accountDisplay) {
      return <span style={{ color: 'var(--text4)', fontSize: 11 }}>{'—'}</span>
    }

    return (
      <div style={{ lineHeight: 1.4, whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)' }}>{accountDisplay}</div>
        {renderServiceLabelWithDestination(displayOrder, truncate(formatServiceCode(getShippedDisplayServiceCode(displayOrder)), 22))}
      </div>
    )
  }

  // PS-071 — bounded/actionable state instead of an indefinite spinner.
  const fallback = renderAwaitingRateFallback(order, displayOrder, 'full')
  if (fallback) return fallback

  return (
    <div
      data-rate-state="ready"
      style={{ lineHeight: 1.4, whiteSpace: 'nowrap' }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)' }}>{getShipAccountDisplay(displayOrder, shippingAccounts)}</div>
      {renderServiceLabelWithDestination(displayOrder, truncate(formatServiceCode(getBestRateServiceCode(displayOrder)), 22))}
    </div>
  )
}
