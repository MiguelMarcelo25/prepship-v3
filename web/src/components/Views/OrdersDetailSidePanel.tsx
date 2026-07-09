// PS-166/PS-306/PS-258 (Wave 5): the order-detail SIDE PANEL (the right-side
// drawer rendered by OrdersView's former `renderSinglePanel`), extracted from
// OrdersView with BYTE-IDENTICAL markup. This panel renders OUTSIDE the
// `#ordersTable` DOM byte-equality cert, so the behavioral net for this slice is
// the orders-ux / site-actions e2e (which CLICK A ROW and open this panel) plus
// the moved-verbatim markup — every id / data-attr / className is preserved
// exactly.
//
// PRESENTATIONAL only — this component owns NO state and owns NO backend truth.
// The dims -> rate -> label interactive core, selected-rate proof, label
  // purchase, package precedence, and persistence ALL stay in the OrdersView
// shell. Every event-handler closure that touched backend truth was LIFTED to a
// NAMED handler in OrdersView (PS-306-tagged) and is passed DOWN here as an
// `on*` callback prop; this leaf only FIRES them. In particular this file owns
// no provider API call, no selected-pid / selected-package persistence, no rate
// re-fetch, and no label purchase — those are parent-owned and arrive as on*
// props. The Ship-Acct PS-189/PS-204 logic and the Confirmation/Insurance
// auto-re-rate live in the parent handlers; the leaf passes the raw value up.
//
// The header derivations that are PURE given the props are computed in-leaf
// VERBATIM (items / mergedItems / shipTo / addressBlock / account+rate labels /
// shipped-label gating / deliveryLine); the derivations that read a stateful
// OrdersView closure (panelDisplayOrder, serviceOptions, dims, panelHold) arrive
// as already-computed props so no stateful closure leaks into this leaf.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  X as XIcon,
  Printer as PrinterIcon,
  Loader2,
  RefreshCcw,
  Inbox,
  Truck,
  Tag,
  Zap,
  Send,
  ClipboardList,
  PackageCheck,
  BadgeCheck,
} from 'lucide-react'
import type { CarrierAccountDto, LocationDto, OrderFullDto, OrderSummaryDto, PackageDto } from '../../types/api'
import type { PanelFormState } from './orders-panel-state'
import type { ShipmentDims } from './orders/panel-shipment-dims'
import {
  formatMoney,
  normalizeShippingAccountName,
  toNumberValue,
  toProviderAccountId,
  toRecord,
  toStringValue,
  getBackendRowMoney,
  getBestRateBaseCost,
  getBestRateServiceCode,
  getSelectedRateBaseCost,
  getShipAccountLabelById,
} from './orders-row-display'
import { resolveAwaitingBestRatePriceDisplay } from './orders/best-rate-price-display'
import { getActiveItems, getAddressBlock, getMergedItems, getShipTo } from './orders-items'
import {
  copyText,
  getIsExternallyFulfilled,
  getIsMissingShipmentSync,
  getRequestedService,
  getShipAccountDisplay,
} from './orders-display-state'
import { formatCarrierCode, formatDateOnly, formatServiceCode } from './orders-formatting'
import { isTestOrder } from './orders-items'
import { getQueueableLabelUrl } from './orders-queue-parsers'
import { normalizeConfirmationForRates } from './orders-rate-input'
import { getCarrierAccountDisplay } from './orders-row-display'

// Confirmation dropdown options — display-only literal. This list is panel-scoped
// now that the Confirmation <select> lives here (the OrdersView shell no longer
// renders it). Kept byte-identical to the former OrdersView CONFIRMATION_OPTIONS.
const CONFIRMATION_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'signature', label: 'Signature' },
  { value: 'adult_signature', label: 'Adult Signature' },
  { value: 'direct_signature', label: 'Direct Signature' },
] as const
import { TEST_CARRIER_CODE } from './orders/test-rate-mock'
import { TEST_SERVICE_CODE, TEST_SHIPPING_ACCOUNT_LABEL, buildTestMockRate } from './orders/test-mock-rate-normalizer'
import { CALIFORNIA_TZ } from '../../lib/ca-time'
import { buildEmptyPanel } from './orders-empty-panel'
import { OrdersPanelItemsSection, OrdersPanelRecipientSection } from './OrdersPanelSections'
import {
  OrdersPanelSaveSkuDefaultsLink,
  OrdersPanelPackageDimsLine,
  OrdersPanelPackageFactsLine,
  OrdersPanelShipFromRow,
  OrdersPanelWeightRow,
  OrdersPanelSizeRow,
  OrdersPanelShippedLabelActions,
} from './OrdersPanelShippingFields'

type PanelSectionKey = 'shipping' | 'items' | 'recipient'

export type OrdersDetailSidePanelProps = {
  // ── DTO / data ────────────────────────────────────────────────
  panelOrder: OrderSummaryDto | null | undefined
  panelDetail: OrderFullDto | null
  // panelDisplayOrder = getOrderWithAutoBestRate(panelOrder) — computed in the
  // OrdersView shell (reads the auto-best-rate cache); passed as a result.
  panelDisplayOrder: OrderSummaryDto
  orderedFilteredOrders: OrderSummaryDto[]
  panelForm: PanelFormState
  setPanelForm: Dispatch<SetStateAction<PanelFormState>>
  panelRatePreview: Array<Record<string, unknown>>
  packages: PackageDto[]
  shippingAccounts: CarrierAccountDto[]
  locations: LocationDto[]
  // serviceOptions = getServiceOptionsForAccount(panelForm.shipAccountId) — the
  // catalog read lives in the shell; the result arrives here.
  serviceOptions: Array<{ code: string; label: string }>
  // dims = the resolved shipment dims (panel form dims, else package dims, else
  // order dims) — computed in the shell; display-only here.
  dims: ShipmentDims | null
  // panelHold = orderShippingHold(...) verdict (PS-128/PS-129) — computed in the shell.
  panelHold: { blocked: boolean; reason: string; status: string } | null
  collapsedSections: Record<PanelSectionKey, boolean>
  selectedOrderIds: number[]

  // ── state flags / values ──────────────────────────────────────
  panelRateLoading: boolean
  singleActionBusy: boolean
  shipmentDetailsSaving: boolean
  activeOrderLoading: boolean
  activeOrderError: unknown
  batchMenuOpen: boolean
  printMenuOpen: boolean
  extShipMenuOpen: boolean
  extShipNotifyCustomer: boolean
  extShipNotifyMarketplace: boolean
  extShipTracking: string
  extShipBusy: boolean

  // ── refs ──────────────────────────────────────────────────────
  dimsUserEditedRef: MutableRefObject<boolean>

  // ── UI-only state setters (passed directly — established pattern) ─
  setBatchMenuOpen: Dispatch<SetStateAction<boolean>>
  setPrintMenuOpen: Dispatch<SetStateAction<boolean>>
  setExtShipMenuOpen: Dispatch<SetStateAction<boolean>>
  setExtShipNotifyCustomer: Dispatch<SetStateAction<boolean>>
  setExtShipNotifyMarketplace: Dispatch<SetStateAction<boolean>>
  setExtShipTracking: Dispatch<SetStateAction<string>>

  // ── closures threaded through to children / verbatim ──────────
  lockstepPanelDims: (next: PanelFormState) => PanelFormState
  onNavigateView?: (view: 'locations' | 'packages') => void
  onHideEmptyPanelChange?: (hidden: boolean) => void

  // ── on* handlers (PS-306: backend-truth bodies live in the parent) ─
  // Ship-Acct change runs the PS-189 service-keep guard + PS-204 stale-preview
  // drop + the selected-pid persistence in the shell; the leaf passes the value.
  onShipAccountChange: (nextValue: string) => void
  // Package change applies package-dims precedence + selected-package persistence in the shell.
  onPackageChange: (packageId: string) => void
  // Confirmation/Insurance changes trigger refreshPanelBestRate in the shell.
  onConfirmationChange: (confirmation: string) => void
  onInsuranceChange: (insurance: string) => void
  onInsuranceValueChange: (insuranceValue: string) => void
  // Action handlers may return a Promise of any value (e.g. the recalculate
  // handler resolves to the persisted rate row) — the leaf only `void`s them, so
  // the result is irrelevant here. onReprintLabel/onQueueExistingLabels stay
  // Promise<void>-compatible because they also feed OrdersPanelShippedLabelActions.
  onCreateOrQueueLabel: (mode: 'print' | 'queue' | 'test') => void | Promise<unknown>
  onCreateOrQueueShopifyLabel?: (mode: 'print' | 'queue') => void | Promise<unknown>
  shopifyLabelPurchase?: { visible: boolean; disabledReason?: string | null }
  onRecalculateBestRate: () => void | Promise<unknown>
  onSaveShipmentDetails: () => void | Promise<unknown>
  onReprintLabel: () => void | Promise<void>
  onQueueExistingLabels: (orderIds: number[]) => void | Promise<void>
  onOpenRateBrowser: () => void | Promise<unknown>
  onOpenVoidConfirm: () => void
  onOpenOrderDetails: (orderId: number) => void
  onCloseSinglePanel: () => void
  onToggleSection: (key: PanelSectionKey) => void
  onToggleResidential: () => void | Promise<void>
  onEditRecipient: () => void
  onSaveSkuDefaults: () => void | Promise<void>
  onMarkOrderShippedExternal: (source: string) => void | Promise<unknown>
  onUpdateSelection: (ids: number[]) => void
}

export function OrdersDetailSidePanel({
  panelOrder,
  panelDetail,
  panelDisplayOrder,
  orderedFilteredOrders,
  panelForm,
  setPanelForm,
  panelRatePreview,
  packages,
  shippingAccounts,
  locations,
  serviceOptions,
  dims,
  panelHold,
  collapsedSections,
  selectedOrderIds,
  panelRateLoading,
  singleActionBusy,
  shipmentDetailsSaving,
  activeOrderLoading,
  activeOrderError,
  batchMenuOpen,
  printMenuOpen,
  extShipMenuOpen,
  extShipNotifyCustomer,
  extShipNotifyMarketplace,
  extShipTracking,
  extShipBusy,
  dimsUserEditedRef,
  setBatchMenuOpen,
  setPrintMenuOpen,
  setExtShipMenuOpen,
  setExtShipNotifyCustomer,
  setExtShipNotifyMarketplace,
  setExtShipTracking,
  lockstepPanelDims,
  onNavigateView,
  onHideEmptyPanelChange,
  onShipAccountChange,
  onPackageChange,
  onConfirmationChange,
  onInsuranceChange,
  onInsuranceValueChange,
  onCreateOrQueueLabel,
  onCreateOrQueueShopifyLabel,
  shopifyLabelPurchase,
  onRecalculateBestRate,
  onSaveShipmentDetails,
  onReprintLabel,
  onQueueExistingLabels,
  onOpenRateBrowser,
  onOpenVoidConfirm,
  onOpenOrderDetails,
  onCloseSinglePanel,
  onToggleSection,
  onToggleResidential,
  onEditRecipient,
  onSaveSkuDefaults,
  onMarkOrderShippedExternal,
  onUpdateSelection,
}: OrdersDetailSidePanelProps) {
  if (!panelOrder) return buildEmptyPanel(onHideEmptyPanelChange ? () => onHideEmptyPanelChange(true) : undefined)

  const items = getActiveItems(panelOrder, panelDetail)
  const mergedItems = getMergedItems(panelOrder, panelDetail)
  const shipTo = getShipTo(panelOrder, panelDetail)
  const requestedService = getRequestedService(panelOrder, panelDetail)
  const panelIndex = orderedFilteredOrders.findIndex((order) => order.orderId === panelOrder.orderId)
  const prevOrderId = panelIndex > 0 ? orderedFilteredOrders[panelIndex - 1]?.orderId ?? null : null
  const nextOrderId = panelIndex >= 0 && panelIndex < orderedFilteredOrders.length - 1 ? orderedFilteredOrders[panelIndex + 1]?.orderId ?? null : null
  const currentWeight = panelOrder.weight?.value ?? 0
  const panelIsTestOrder = isTestOrder(panelOrder, panelDetail)
  const serviceCodeMissingFromOptions = Boolean(
    panelForm.serviceCode &&
    !panelIsTestOrder &&
    !serviceOptions.some((option) => option.code === panelForm.serviceCode)
  )
  const selectedPanelAccountLabel = panelIsTestOrder
    ? TEST_SHIPPING_ACCOUNT_LABEL
    : getShipAccountLabelById(shippingAccounts, panelForm.shipAccountId) ?? getShipAccountDisplay(panelDisplayOrder, shippingAccounts)
  const panelBestRateAccountLabel = panelIsTestOrder
    ? TEST_SHIPPING_ACCOUNT_LABEL
    : getShipAccountDisplay(panelDisplayOrder, shippingAccounts)
  const panelPreviewRate = panelRatePreview[0] ?? null
  const panelPreviewProviderId = panelPreviewRate ? toProviderAccountId(panelPreviewRate.shippingProviderId) : null
  const panelPreviewAccountLabel = panelPreviewRate
    ? normalizeShippingAccountName(panelPreviewRate.carrierNickname) ??
    (panelPreviewProviderId != null
      ? getShipAccountLabelById(shippingAccounts, String(panelPreviewProviderId))
      : null) ??
    formatCarrierCode(toStringValue(panelPreviewRate.carrierCode))
    : null
  const panelTestRate: Record<string, unknown> | null = panelIsTestOrder ? ((panelRatePreview[0] ?? panelOrder.bestRate ?? buildTestMockRate()) as Record<string, unknown>) : null
  const panelTestRateAmount = panelTestRate
    ? (toNumberValue(panelTestRate.shipmentCost) ?? 0) + (toNumberValue(panelTestRate.otherCost) ?? 0)
    : 0
  const panelTestRateDetail = panelTestRate
    ? `${toStringValue(panelTestRate.carrierNickname) ?? formatCarrierCode(toStringValue(panelTestRate.carrierCode))} · ${toStringValue(panelTestRate.serviceName) ?? formatServiceCode(toStringValue(panelTestRate.serviceCode))}`
    : `${TEST_SHIPPING_ACCOUNT_LABEL} · PrepShip Test Standard`
  const sidePanelBackendMoney = getBackendRowMoney(panelDisplayOrder)
  const sidePanelBestRatePriceDisplay = sidePanelBackendMoney
    ? resolveAwaitingBestRatePriceDisplay({
      markupSource: sidePanelBackendMoney.markupSource,
      selectedRateCost: sidePanelBackendMoney.selectedRateCost,
      baseAmount: sidePanelBackendMoney.baseAmount,
      cShippingRateAmount: sidePanelBackendMoney.cShippingRateAmount,
      markedAmount: sidePanelBackendMoney.markedAmount,
      insuranceAddOn: sidePanelBackendMoney.insuranceAddOn,
      fallbackAmount: getBestRateBaseCost(panelDisplayOrder),
      customerRateSource: sidePanelBackendMoney.customerRateSource,
    })
    : null
  const shipped = panelOrder.orderStatus !== 'awaiting_shipment'
  const shopifyLabelVisible = shopifyLabelPurchase?.visible === true && !shipped
  const shopifyLabelDisabledReason = shopifyLabelPurchase?.disabledReason ?? (panelHold?.blocked ? panelHold.reason : null)
  const trackingNumber = toStringValue(panelOrder.label?.trackingNumber)
  const shippedHasPrepShipLabel = shipped && !getIsExternallyFulfilled(panelOrder) && !getIsMissingShipmentSync(panelOrder)
  // Per user override unlock shipped data on 2026-05-23: keep shipped queue recovery non-destructive, but disable corrupt saved label URLs.
  const shippedQueueableLabelUrl = getQueueableLabelUrl(panelOrder.label?.labelUrl)
  const canQueueShippedLabel = Boolean(shippedQueueableLabelUrl && panelOrder.clientId != null)
  const shippedLabelUnavailableCopy = getIsExternallyFulfilled(panelOrder)
    ? 'External label - reprint in marketplace or carrier'
    : getIsMissingShipmentSync(panelOrder)
      ? 'Shipment sync error — re-run ShipStation sync to backfill label data'
      : shippedQueueableLabelUrl
        ? 'No client selected for print queue'
        : 'No saved queueable PrepShip label URL yet'
  const deliveryLine = panelOrder.label?.shipDate
    ? `Shipped: ${formatDateOnly(panelOrder.label.shipDate, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`
    : 'Delivery: —'
  const addressBlock = getAddressBlock(panelOrder, panelDetail)

  return (
    <>
        {/* ─────────────────────────────────────────────────────────
            REFINED OPERATOR CONSOLE — Side panel header (sticky)

            Three-row architecture:
              1. Order # + nav arrows + utility icons (compact, sticky)
              2. Status strip (status pill + source + test marker)
              3. (sections begin)

            Design moves:
              • Order # in monospaced, prominent, ellipsis-truncated
              • Nav arrows are square ghost-icon buttons (ChevronLeft/Right)
              • Secondary actions (Batch, Print, External Ship) collapse
                into a single MoreHorizontal kebab dropdown to reduce
                visual noise — keeps power-user shortcuts available
                without crowding the header
              • Open-in-ShipStation = minimal ExternalLink icon button
              • Close X = standard ghost icon button on far right
            ───────────────────────────────────────────────────────── */}
        <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur-sm border-b border-line">
          {/* Row 1 — Identity + navigation + actions */}
          <div className="flex items-center gap-1 px-3 py-2">
            {/* Nav arrow group */}
            <div className="flex items-center gap-0.5 mr-1">
              <button
                type="button"
                onClick={() => prevOrderId != null && onOpenOrderDetails(prevOrderId)}
                disabled={prevOrderId == null}
                title="Previous order"
                aria-label="Previous order"
                className="inline-flex items-center justify-center w-6 h-6 rounded text-ink-3 hover:text-ink hover:bg-surface-2 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-3 transition"
              >
                <ChevronLeft size={14} strokeWidth={2.5} />
              </button>
              <button
                type="button"
                onClick={() => nextOrderId != null && onOpenOrderDetails(nextOrderId)}
                disabled={nextOrderId == null}
                title="Next order"
                aria-label="Next order"
                className="inline-flex items-center justify-center w-6 h-6 rounded text-ink-3 hover:text-ink hover:bg-surface-2 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-3 transition"
              >
                <ChevronRight size={14} strokeWidth={2.5} />
              </button>
            </div>

            {/* Order number — primary identity, monospaced, truncated */}
            <div className="flex-1 min-w-0 flex items-baseline gap-2">
              <span
                className="font-mono text-[13px] font-semibold text-ink truncate tracking-tight"
                title={panelOrder.orderNumber ?? `#${panelOrder.orderId}`}
              >
                {panelOrder.orderNumber ?? `#${panelOrder.orderId}`}
              </span>
              {panelIndex >= 0 ? (
                <span className="text-[10px] font-medium text-ink-4 tabular-nums shrink-0">
                  {panelIndex + 1}/{orderedFilteredOrders.length}
                </span>
              ) : null}
            </div>

            {/* Utility icon buttons — Batch menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setBatchMenuOpen((open) => !open)}
                title="Batch actions"
                aria-label="Batch actions"
                className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium text-ink-2 hover:text-ink hover:bg-surface-2 ring-1 ring-line hover:ring-line-2 transition"
              >
                <ClipboardList size={11} strokeWidth={2.25} />
                <span>Batch</span>
                <ChevronDown size={9} strokeWidth={2.5} className="text-ink-3" />
              </button>
              {batchMenuOpen ? (
                <div className="absolute top-[calc(100%+4px)] left-0 z-30 min-w-[200px] rounded-lg bg-surface ring-1 ring-line shadow-lg py-1 text-[12px]">
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-ink-2 hover:text-ink hover:bg-surface-2 transition"
                    onClick={() => { setBatchMenuOpen(false); onUpdateSelection([panelOrder.orderId, ...selectedOrderIds.filter((id) => id !== panelOrder.orderId)]) }}
                  >
                    <Inbox size={12} strokeWidth={2.25} className="text-ink-3" />
                    Add to Batch Queue
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-ink-2 hover:text-ink hover:bg-surface-2 transition"
                    onClick={() => { setBatchMenuOpen(false); void onQueueExistingLabels([panelOrder.orderId]) }}
                  >
                    <RefreshCcw size={12} strokeWidth={2.25} className="text-ink-3" />
                    Quick Reprint (Batch)
                  </button>
                </div>
              ) : null}
            </div>

            {/* Print menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setPrintMenuOpen((open) => !open)}
                title="Print options"
                aria-label="Print options"
                className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium text-ink-2 hover:text-ink hover:bg-surface-2 ring-1 ring-line hover:ring-line-2 transition"
              >
                <PrinterIcon size={11} strokeWidth={2.25} />
                <ChevronDown size={9} strokeWidth={2.5} className="text-ink-3" />
              </button>
              {printMenuOpen ? (
                <div className="absolute top-[calc(100%+4px)] right-0 z-30 min-w-[180px] rounded-lg bg-surface ring-1 ring-line shadow-lg py-1 text-[12px]">
                  {shipped ? (
                    shippedHasPrepShipLabel ? (
                      <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-ink-2 hover:text-ink hover:bg-surface-2 transition"
                        onClick={() => { setPrintMenuOpen(false); void onReprintLabel() }}
                      >
                        <PrinterIcon size={12} strokeWidth={2.25} className="text-ink-3" />
                        Reprint Label
                      </button>
                    ) : (
                      <div className="px-3 py-2 text-[11.5px] leading-snug text-ink-4">
                        {shippedLabelUnavailableCopy}
                      </div>
                    )
                  ) : (
                    <button
                      type="button"
                      className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-ink-2 hover:text-ink hover:bg-surface-2 transition"
                      onClick={() => { setPrintMenuOpen(false); void onCreateOrQueueLabel('test') }}
                    >
                      <Tag size={12} strokeWidth={2.25} className="text-ink-3" />
                      Create Test Label
                    </button>
                  )}
                </div>
              ) : null}
            </div>

            {/* Open in ShipStation */}
            <a
              href={`https://ship.shipstation.com/orders/${panelOrder.orderId}`}
              target="_blank"
              rel="noreferrer"
              title="Open in ShipStation"
              aria-label="Open in ShipStation"
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 transition"
            >
              <ExternalLink size={12} strokeWidth={2.25} />
            </a>

            {/* Close panel */}
            <button
              type="button"
              onClick={onCloseSinglePanel}
              title="Close panel"
              aria-label="Close panel"
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 transition"
            >
              <XIcon size={13} strokeWidth={2.5} />
            </button>
          </div>

          {/* Row 2 — Status strip (only when meaningful) */}
          {!shipped || panelIsTestOrder ? (
            <div className="flex items-center gap-1.5 px-3 pb-2 -mt-0.5">
              {/* Order status pill */}
              {shipped ? (
                <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-ok-bg text-ok-dark ring-1 ring-ok-border">
                  <PackageCheck size={9} strokeWidth={2.5} />
                  Shipped
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-50 text-amber-700 ring-1 ring-amber-200">
                  <Send size={9} strokeWidth={2.5} />
                  Awaiting
                </span>
              )}

              {/* Test order indicator */}
              {panelIsTestOrder ? (
                <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-brand-bg text-brand ring-1 ring-brand-border">
                  <Zap size={9} strokeWidth={2.5} />
                  Test
                </span>
              ) : null}

              {/* External-shipped action — quiet outline button on the right */}
              {!shipped ? (
                <div className="ml-auto relative">
                  <button
                    type="button"
                    onClick={() => setExtShipMenuOpen((open) => !open)}
                    title="Mark this order as shipped externally (no label purchase)"
                    className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-semibold text-amber-800 bg-amber-50/80 ring-1 ring-amber-200 hover:bg-amber-100 hover:ring-amber-300 transition"
                  >
                    <BadgeCheck size={10} strokeWidth={2.5} />
                    Mark as Shipped
                    <ChevronDown size={8} strokeWidth={2.5} className="opacity-60" />
                  </button>
                  {extShipMenuOpen ? (
                    <div className="absolute top-[calc(100%+4px)] right-0 z-30 w-[260px] rounded-lg bg-surface ring-1 ring-line shadow-lg overflow-hidden text-[12px]">
                      {/* Header */}
                      <div className="px-3 py-2 bg-surface-2 border-b border-line">
                        <div className="font-semibold text-ink text-[12px]">Mark as Shipped</div>
                        <div className="text-ink-3 text-[10.5px] mt-0.5">
                          Closes the order locally. Optional notify:
                        </div>
                      </div>

                      {/* Notify Customer toggle */}
                      <label className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-surface-2 cursor-pointer">
                        <div className="flex flex-col">
                          <span className="font-medium text-ink-2 text-[11.5px]">Notify customer</span>
                          <span className="text-ink-3 text-[10px]">Email shipping confirmation via ShipStation</span>
                        </div>
                        {/* Compact iOS-style toggle — visible on/off state without a checkbox icon */}
                        <span
                          className={`relative inline-flex w-8 h-4 rounded-full transition-colors duration-150 flex-shrink-0 ${extShipNotifyCustomer ? 'bg-emerald-500' : 'bg-line'}`}
                          aria-hidden
                        >
                          <span
                            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${extShipNotifyCustomer ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
                            aria-hidden
                          />
                        </span>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={extShipNotifyCustomer}
                          onChange={(e) => setExtShipNotifyCustomer(e.target.checked)}
                        />
                      </label>

                      {/* Notify Marketplace toggle */}
                      <label className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-surface-2 cursor-pointer border-b border-line">
                        <div className="flex flex-col">
                          <span className="font-medium text-ink-2 text-[11.5px]">Notify marketplace</span>
                          <span className="text-ink-3 text-[10px]">Push shipped status to Amazon/eBay/etc.</span>
                        </div>
                        <span
                          className={`relative inline-flex w-8 h-4 rounded-full transition-colors duration-150 flex-shrink-0 ${extShipNotifyMarketplace ? 'bg-emerald-500' : 'bg-line'}`}
                          aria-hidden
                        >
                          <span
                            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${extShipNotifyMarketplace ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
                            aria-hidden
                          />
                        </span>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={extShipNotifyMarketplace}
                          onChange={(e) => setExtShipNotifyMarketplace(e.target.checked)}
                        />
                      </label>

                      {/* Tracking number input — only really useful when
                          a notify toggle is on (the notification email
                          embeds the tracking link). We render it always
                          so power-users can record tracking even without
                          notification, but show a hint below it. */}
                      <div className="px-3 py-2 border-b border-line">
                        <label className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3 block mb-1">
                          Tracking # <span className="font-normal lowercase tracking-normal text-ink-4">(optional)</span>
                        </label>
                        <input
                          type="text"
                          value={extShipTracking}
                          onChange={(e) => setExtShipTracking(e.target.value)}
                          placeholder="e.g. 1Z999AA10123456784"
                          className="w-full h-7 px-2 rounded ring-1 ring-line bg-surface text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:ring-brand outline-none transition"
                        />
                        {(extShipNotifyCustomer || extShipNotifyMarketplace) && !extShipTracking.trim() ? (
                          <div className="text-[10px] text-amber-700 mt-1 flex items-center gap-1">
                            <span aria-hidden>⚠</span>
                            <span>Notify will send empty tracking — recipient sees "tracking pending"</span>
                          </div>
                        ) : null}
                      </div>

                      {/* Marketplace picker — clicking submits the action.
                          The picked marketplace is stored as the
                          externallyShippedSource override (existing
                          behavior). Disabled while a request is in flight
                          so a double-click doesn't double-fire. */}
                      <div className="px-2 py-1.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3 px-1 pb-1">
                          Source marketplace
                        </div>
                        {['Shopify', 'Amazon', 'Walmart', 'eBay', 'Etsy', 'Other'].map((source) => (
                          <button
                            key={source}
                            type="button"
                            disabled={extShipBusy}
                            className="w-full text-left px-2 py-1.5 rounded text-ink-2 hover:text-ink hover:bg-surface-2 transition disabled:opacity-50 disabled:cursor-wait text-[11.5px]"
                            onClick={() => {
                              setExtShipMenuOpen(false)
                              void onMarkOrderShippedExternal(source)
                            }}
                          >
                            {extShipBusy ? `Working… (${source})` : source}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="panel-body">
          {/* ─────────────────────────────────────────────────────────
              SHIPPING SECTION
              Header: Truck icon + title + chevron toggle
              Sub-strip: "Requested service" — quiet info chip with
              a clickable link styling the carrier-suggested service
              ───────────────────────────────────────────────────────── */}
          <div className={`panel-section${collapsedSections.shipping ? ' collapsed' : ''}`} id="sec-shipping">
            <button
              type="button"
              onClick={() => onToggleSection('shipping')}
              className="w-full flex items-center gap-2 px-3 py-2.5 bg-surface hover:bg-surface-2 transition group"
            >
              <Truck size={13} strokeWidth={2.25} className="text-ink-3 group-hover:text-ink-2 transition" />
              <span className="flex-1 text-left text-[12px] font-semibold text-ink-2 tracking-tight uppercase letter-spacing-wider">
                Shipping
              </span>
              <ChevronDown
                size={13}
                strokeWidth={2.5}
                className={`text-ink-3 transition-transform ${collapsedSections.shipping ? '-rotate-90' : ''}`}
              />
            </button>

            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2/60 border-y border-line text-[11px]">
              <span className="text-ink-3 font-medium">Requested</span>
              <span className="text-ink-2">·</span>
              <span className="text-brand font-semibold cursor-pointer hover:underline">
                {(requestedService ?? 'Standard').replace(/_/g, ' ')}
              </span>
              {!panelOrder.carrierCode ? (
                <span className="text-ink-4 font-medium">(unmapped)</span>
              ) : null}
            </div>

            <div className="panel-section-body">
              {/* PS-166 W4c: Ship From row extracted to OrdersPanelShipFromRow (byte-identical). */}
              <OrdersPanelShipFromRow
                panelForm={panelForm}
                setPanelForm={setPanelForm}
                shipped={shipped}
                locations={locations}
                onNavigateView={onNavigateView}
              />

              <div className="ship-field-row">
                <span className="ship-field-label">Ship Acct</span>
                <div className="ship-field-value">
                  <select
                    className="ship-select"
                    style={{ flex: 1 }}
                    value={panelForm.shipAccountId}
                    disabled={shipped || panelIsTestOrder}
                    onChange={(event) => onShipAccountChange(event.target.value)}
                  >
                    <option value="">— Select Account —</option>
                    {panelIsTestOrder ? <option value={TEST_CARRIER_CODE}>{TEST_SHIPPING_ACCOUNT_LABEL}</option> : null}
                    {shippingAccounts.map((account, i) => {
                      const key = account.shippingProviderId || account.carrierId || account.code || i
                      return (
                        <option key={key} value={account.shippingProviderId || key}>
                          {getCarrierAccountDisplay(account) ?? account.code}
                        </option>
                      )
                    })}
                  </select>
                </div>
              </div>

              <div className="ship-field-row">
                <span className="ship-field-label">Service</span>
                <div className="ship-field-value">
                  <select className="ship-select" style={{ flex: 1 }} value={panelForm.serviceCode} disabled={shipped || panelIsTestOrder} onChange={(event) => setPanelForm((current) => ({ ...current, serviceCode: event.target.value }))}>
                    {panelIsTestOrder && panelForm.serviceCode && panelForm.serviceCode !== TEST_SERVICE_CODE ? (
                      <option value={panelForm.serviceCode}>{formatServiceCode(panelForm.serviceCode)}</option>
                    ) : null}
                    {panelIsTestOrder ? <option value={TEST_SERVICE_CODE}>PrepShip Test Standard</option> : null}
                    {serviceCodeMissingFromOptions ? (
                      <option value={panelForm.serviceCode}>{formatServiceCode(panelForm.serviceCode)}</option>
                    ) : null}
                    <option value="">{panelForm.serviceCode ? formatServiceCode(panelForm.serviceCode) : 'Select Service'}</option>
                    {serviceOptions.map((option) => (
                      <option key={option.code} value={option.code}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* PS-166 W4e: Weight row extracted to OrdersPanelWeightRow (byte-identical; threads the mutable dimsUserEditedRef). */}
              <OrdersPanelWeightRow
                panelForm={panelForm}
                setPanelForm={setPanelForm}
                shipped={shipped}
                dimsUserEditedRef={dimsUserEditedRef}
              />

              {/* PS-166 W4f: Size row extracted to OrdersPanelSizeRow (byte-identical; threads dimsUserEditedRef + lockstepPanelDims). */}
              <OrdersPanelSizeRow
                panelForm={panelForm}
                setPanelForm={setPanelForm}
                shipped={shipped}
                dimsUserEditedRef={dimsUserEditedRef}
                lockstepPanelDims={lockstepPanelDims}
              />

              <div className="ship-field-row" style={{ borderBottom: 'none', paddingBottom: 2 }}>
                <span className="ship-field-label">Package</span>
                <div className="ship-field-value">
                  <select
                    className="ship-select"
                    style={{ flex: 1 }}
                    value={panelForm.packageId}
                    disabled={shipped}
                    onChange={(event) => onPackageChange(event.target.value)}
                  >
                    <option value="">— Select Package —</option>
                    {packages.map((pkg) => (
                      <option key={pkg.packageId ?? (pkg as any).id ?? pkg.name} value={pkg.packageId ?? (pkg as any).id ?? ''}>{pkg.name}</option>
                    ))}
                  </select>
                  <button className="ship-icon-btn" type="button" title="Manage packages" onClick={() => onNavigateView?.('packages')}>📐</button>
                </div>
              </div>

              {/* PS-166 W4b: package-dims line extracted to OrdersPanelPackageDimsLine (byte-identical). */}
              <OrdersPanelPackageDimsLine dims={dims} />
              {/* PS-304 (FE consumption): the backend-owned row package-facts verdict — first
                  consumer of order.packageFacts. Display-only; renders nothing unless locked/stale. */}
              <OrdersPanelPackageFactsLine packageFacts={panelOrder?.packageFacts ?? null} />

              {/* User override "unlock shipped data" on 2026-05-15: expose shipped PrepShip label reprint/queue actions while keeping external labels disabled.
                  PS-166 W4d — Per user override unlock shipped data on 2026-06-13: the shipped-label-actions surface moved VERBATIM to
                  OrdersPanelShippedLabelActions (handlers stay in this shell; external-label gating preserved; no protection weakened). */}
              {shipped ? (
                <OrdersPanelShippedLabelActions
                  panelOrder={panelOrder}
                  reprintLabel={onReprintLabel}
                  queueExistingLabels={onQueueExistingLabels}
                  shippedHasPrepShipLabel={shippedHasPrepShipLabel}
                  canQueueShippedLabel={canQueueShippedLabel}
                  shippedLabelUnavailableCopy={shippedLabelUnavailableCopy}
                  labelVoidability={panelDetail?.labelVoidability ?? null}
                  onVoidLabel={() => onOpenVoidConfirm()}
                />
              ) : (
                <div style={{ padding: '4px 0', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary btn-sm" type="button" style={{ fontSize: 11.5, gap: 4 }} onClick={() => void onOpenRateBrowser()}>🔍 Browse Rates</button>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    style={{
                      fontSize: 11.5,
                      gap: 4,
                      borderColor: 'var(--green-border)',
                      color: 'var(--green-dark)',
                    }}
                    onClick={() => void onSaveShipmentDetails()}
                    disabled={shipmentDetailsSaving}
                  >
                    {shipmentDetailsSaving ? 'Saving...' : 'Save'}
                  </button>
                  {shopifyLabelVisible ? (
                    <div className="basis-full rounded-md border border-sky-200 bg-sky-50 px-2 py-2">
                      <div className="text-[11px] font-semibold text-sky-950">
                        Shopify chooses the cheapest available label at purchase time.
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          className="btn btn-primary btn-sm"
                          type="button"
                          style={{ fontSize: 11.5, gap: 4 }}
                          onClick={() => void onCreateOrQueueShopifyLabel?.('print')}
                          disabled={singleActionBusy || Boolean(shopifyLabelDisabledReason)}
                          title={shopifyLabelDisabledReason ? `Blocked: ${shopifyLabelDisabledReason}` : 'Buy Shopify label'}
                        >
                          {singleActionBusy ? 'Working...' : 'Buy Shopify Label'}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          style={{ fontSize: 11.5, gap: 4 }}
                          onClick={() => void onCreateOrQueueShopifyLabel?.('queue')}
                          disabled={singleActionBusy || Boolean(shopifyLabelDisabledReason)}
                          title={shopifyLabelDisabledReason ? `Blocked: ${shopifyLabelDisabledReason}` : 'Buy Shopify label and add it to the print queue'}
                        >
                          Queue Shopify Label
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}

              <div className="ship-field-row">
                <span className="ship-field-label">Confirmation</span>
                <div className="ship-field-value">
                  <select
                    className="ship-select"
                    value={normalizeConfirmationForRates(panelForm.confirmation)}
                    disabled={shipped}
                    onChange={(event) => onConfirmationChange(event.target.value)}
                  >
                    {CONFIRMATION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="ship-field-row">
                <span className="ship-field-label">Insurance</span>
                <div className="ship-field-value" style={{ gap: 5, flexWrap: 'wrap' }}>
                  <select className="ship-select" value={panelForm.insurance} style={{ flex: 1 }} disabled={shipped} onChange={(event) => onInsuranceChange(event.target.value)}>
                    <option value="none">None</option>
                    <option value="carrier">Carrier (up to $100)</option>
                    <option value="parcelguard">Parcel Guard</option>
                    <option value="shipsurance">Shipsurance</option>
                  </select>
                  <input
                    type="number"
                    className="ship-input ship-input-sm"
                    value={panelForm.insuranceValue}
                    placeholder="$0.00"
                    style={{ width: 68, display: panelForm.insurance !== 'none' ? 'block' : 'none' }}
                    readOnly={shipped}
                    onChange={(event) => onInsuranceValueChange(event.target.value)}
                  />
                </div>
              </div>

              {/* Save weights/dims link — quiet text-link inside the
                  shipping form. Demoted from a green pill to a subtle
                  inline action so the visual weight goes to the
                  Decision Card below. PS-166 W4a: extracted to
                  OrdersPanelSaveSkuDefaultsLink (byte-identical markup;
                  the saveSkuDefaults handler stays in this shell). */}
              <OrdersPanelSaveSkuDefaultsLink shipped={shipped} saveSkuDefaults={onSaveSkuDefaults} />
            </div>
          </div>

          {/* ─────────────────────────────────────────────────────────
              DECISION CARD — Rate display + action buttons grouped
              together into a single visually-bounded surface. The
              operator's eyes land here to make the shipping call:

                ┌───────────────────────────────┐
                │ RATE       $6.62              │
                │ Carrier · Service             │
                ├───────────────────────────────┤
                │ [Create + Print] [Queue] Test │
                └───────────────────────────────┘

              For shipped orders, just shows the locked rate.
              For test orders, shows the mock rate.
              For awaiting orders, shows live rate calc + refresh link.
              ───────────────────────────────────────────────────────── */}
          <div className="px-3 py-3">
            <div className="rounded-xl bg-surface ring-1 ring-line shadow-[0_1px_2px_rgba(15,23,42,0.04)] overflow-hidden">
              {/* Rate row */}
              <div className="flex items-center gap-3 px-3.5 py-3 border-b border-line">
                <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-4">Rate</span>
                  {panelIsTestOrder ? (
                    <>
                      <span className="text-[18px] font-bold tabular-nums leading-none text-brand font-display">
                        {formatMoney(panelTestRateAmount)}
                      </span>
                      <span className="text-[11px] text-ink-3 leading-snug truncate">{panelTestRateDetail}</span>
                    </>
                  ) : shipped ? (
                    getIsExternallyFulfilled(panelOrder) ? (
                      <span className="text-[12.5px] text-ink-3 italic leading-snug">External label — purchased externally</span>
                    ) : getIsMissingShipmentSync(panelOrder) ? (
                      <span className="text-[12.5px] text-amber-700 italic leading-snug">Shipment sync error — re-run ShipStation sync</span>
                    ) : (
                      <>
                        <span className="text-[18px] font-bold tabular-nums leading-none text-ink font-display">
                          {formatMoney(panelOrder.label?.cost ?? panelOrder.selectedRate?.cost ?? getSelectedRateBaseCost(panelOrder))}
                        </span>
                        <span className="text-[11px] text-ink-3 leading-snug truncate">
                          {selectedPanelAccountLabel} · {formatServiceCode(panelForm.serviceCode)}
                        </span>
                      </>
                    )
                  ) : panelRateLoading ? (
                    <div
                      className="flex items-center py-1"
                      title="Loading best rate"
                      role="status"
                      aria-label="Loading best rate"
                    >
                      <Loader2 size={15} strokeWidth={2.5} className="animate-spin text-brand" />
                    </div>
                  ) : panelDisplayOrder.bestRate ? (
                    <>
                      {/* PS-357: mirror the Best Rate column display policy over the backend money tuple.
                          HOUSE shows purchase cost; C. Shipping owns the customer billing amount. */}
                      <span className="text-[18px] font-bold tabular-nums leading-none text-brand font-display">
                        {formatMoney(sidePanelBestRatePriceDisplay?.primaryAmount ?? getBestRateBaseCost(panelDisplayOrder))}
                      </span>
                      <span className="text-[11px] text-ink-3 leading-snug truncate">
                        {panelBestRateAccountLabel} · {formatServiceCode(panelForm.serviceCode || getBestRateServiceCode(panelDisplayOrder))}
                      </span>
                    </>
                  ) : panelPreviewRate ? (
                    <>
                      {/* PS-278: the preview rate carries only the RAW carrier cost (shipmentCost/otherCost),
                          NOT the backend MARKED money tuple the column/SOT shows — adding them here would
                          invent FE money that diverges from the billed amount whenever a markup applies.
                          refreshPanelBestRate persists every live result to the SOT, so the authoritative
                          marked amount appears via the SOT branch above within a tick; until then show a
                          pending placeholder rather than an un-marked number. */}
                      <span className="text-[13px] font-semibold leading-none text-ink-3 inline-flex items-center gap-1">
                        <Loader2 size={11} strokeWidth={2.5} className="animate-spin" /> finalizing rate…
                      </span>
                      <span className="text-[11px] text-ink-3 leading-snug truncate">
                        {panelPreviewAccountLabel} · {formatServiceCode(toStringValue(panelPreviewRate.serviceCode))}
                      </span>
                    </>
                  ) : (
                    <span className="text-[14px] text-ink-4">—</span>
                  )}
                </div>

                {/* Recalculate button - strict live best-rate update for the selected order. */}
                {!panelIsTestOrder && !shipped ? (
                  <button
                    type="button"
                    onClick={() => void onRecalculateBestRate()}
                    disabled={panelRateLoading}
                    title="Recalculate the live cheapest rate"
                    className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-md text-[10.5px] font-semibold text-ink-3 hover:text-brand hover:bg-brand/5 transition disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {panelRateLoading ? (
                      <Loader2 size={11} strokeWidth={2.5} className="animate-spin" />
                    ) : (
                      <RefreshCcw size={11} strokeWidth={2.5} />
                    )}
                    <span className="hidden sm:inline">Recalculate</span>
                  </button>
                ) : null}
              </div>

              {/* Action buttons row — only when awaiting a label */}
              {shipped ? null : (
                <div className="flex flex-col gap-1 p-1.5 bg-surface-2/40">
                  {/* PS-128/PS-129: shipping-hold banner. Backend hard-blocks; this explains why. */}
                  {panelHold?.blocked ? (
                    <div
                      role="alert"
                      className="px-2 py-1.5 rounded-md bg-danger-bg text-danger ring-1 ring-danger-border/40 text-[11.5px] font-semibold"
                    >
                      ⛔ {panelHold.status}. Buying a label is blocked — {panelHold.reason}.
                    </div>
                  ) : null}
                  <div className="flex items-stretch gap-1">
                  <button
                    type="button"
                    onClick={() => void onCreateOrQueueLabel('print')}
                    disabled={singleActionBusy || Boolean(panelHold?.blocked)}
                    aria-busy={singleActionBusy}
                    title={panelHold?.blocked ? `Blocked: ${panelHold.reason}` : 'Buy postage and open the shipping label now'}
                    className={[
                      'flex-[5] inline-flex items-center justify-center gap-2',
                      'h-9 rounded-lg',
                      'text-[12.5px] font-semibold tracking-tight text-white',
                      'bg-brand hover:bg-brand-dark',
                      'shadow-[0_1px_2px_rgba(42,91,215,0.20),inset_0_1px_0_rgba(255,255,255,0.12)]',
                      'active:scale-[0.985]',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
                      'transition-all duration-150 ease-out',
                    ].join(' ')}
                  >
                    {singleActionBusy ? (
                      <Loader2 size={13} strokeWidth={2.5} className="animate-spin" aria-hidden />
                    ) : (
                      <PrinterIcon size={13} strokeWidth={2.5} aria-hidden />
                    )}
                    <span>{singleActionBusy ? 'Working…' : 'Create + Print Label'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void onCreateOrQueueLabel('queue')}
                    disabled={singleActionBusy || Boolean(panelHold?.blocked)}
                    aria-busy={singleActionBusy}
                    title={panelHold?.blocked ? `Blocked: ${panelHold.reason}` : "Buy postage but don't open the label — adds it to the print queue for batch printing"}
                    className={[
                      'flex-[3] inline-flex items-center justify-center gap-1.5',
                      'h-9 px-2 rounded-lg',
                      'text-[12.5px] font-semibold text-ink-2',
                      'bg-surface ring-1 ring-line',
                      'hover:text-ink hover:ring-line-2 hover:bg-surface',
                      'active:scale-[0.98]',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
                      'transition-all duration-150 ease-out',
                    ].join(' ')}
                  >
                    <Inbox size={12.5} strokeWidth={2.25} aria-hidden />
                    <span>Print to Queue</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void onCreateOrQueueLabel('test')}
                    disabled={singleActionBusy || Boolean(panelHold?.blocked)}
                    aria-busy={singleActionBusy}
                    title={panelHold?.blocked ? `Blocked: ${panelHold.reason}` : "Create a VOID mock label for testing — no postage charged, label is watermarked 'VOID — DO NOT SHIP'"}
                    className={[
                      'inline-flex items-center justify-center',
                      'h-9 px-3 rounded-lg',
                      'text-[11.5px] font-semibold text-ink-3',
                      'bg-transparent',
                      'hover:text-ink hover:bg-surface',
                      'active:scale-95',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
                      'transition-all duration-150 ease-out',
                    ].join(' ')}
                  >
                    Test
                  </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ─────────────────────────────────────────────────────────
              TRACKING + DELIVERY STRIP
              When shipped: tracking number (mono, copyable) + Reprint
              Always: delivery line (compact info row)
              ───────────────────────────────────────────────────────── */}
          {shipped && trackingNumber ? (
            <div className="flex items-center gap-2 px-3 py-2 bg-ok-bg/40 border-y border-ok-border/40">
              <PackageCheck size={12} strokeWidth={2.25} className="text-ok-dark shrink-0" />
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ok-dark">Tracking</span>
              <button
                type="button"
                onClick={() => copyText(trackingNumber)}
                title="Click to copy tracking number"
                className="font-mono text-[11px] font-semibold text-ink hover:text-brand transition truncate"
              >
                {trackingNumber}
              </button>
              {/* Backend-owned carrier tracking status (shipment-tracking poller).
                  Display-only: delivered/in-transit/exception; quiet otherwise. */}
              {(() => {
                const tracking = toRecord((panelDetail as Record<string, unknown> | null)?.tracking)
                const trackingStatus = toStringValue(tracking?.status)
                if (!trackingStatus) return null
                if (trackingStatus === 'delivered') {
                  const deliveredAtRaw = toStringValue(tracking?.deliveredAt)
                  const deliveredLabel = deliveredAtRaw
                    ? new Date(deliveredAtRaw).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: CALIFORNIA_TZ })
                    : null
                  return (
                    <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 text-[10px] font-bold uppercase tracking-wide ring-1 ring-emerald-200 shrink-0">
                      Delivered{deliveredLabel ? ` ${deliveredLabel}` : ''}
                    </span>
                  )
                }
                if (trackingStatus === 'in_transit') {
                  return <span className="ml-auto text-[10.5px] font-semibold text-ink-3 shrink-0">In transit</span>
                }
                if (trackingStatus === 'exception' || trackingStatus === 'return_to_sender') {
                  return (
                    <span className="ml-auto inline-flex items-center px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 text-[10px] font-bold uppercase tracking-wide ring-1 ring-amber-200 shrink-0">
                      Tracking exception
                    </span>
                  )
                }
                return null
              })()}
            </div>
          ) : null}

          {/* Delivery line — quiet info row */}
          <div className="px-3 py-1.5 text-[10.5px] text-ink-3 border-b border-line">
            {deliveryLine}
          </div>

          {/* ─────────────────────────────────────────────────────────
              ITEMS SECTION
              Header: Box icon + title + chevron
              Body: stacked rows with thumbnail · name/sku/price · qty
              ───────────────────────────────────────────────────────── */}
          <OrdersPanelItemsSection
            collapsedSections={collapsedSections}
            toggleSection={onToggleSection}
            items={items}
            mergedItems={mergedItems}
          />

          {/* ─────────────────────────────────────────────────────────
              RECIPIENT SECTION
              Header: MapPin icon + title + chevron
              Body: ship-to address card + sold-to + validation status
              ───────────────────────────────────────────────────────── */}
          <OrdersPanelRecipientSection
            collapsedSections={collapsedSections}
            toggleSection={onToggleSection}
            shipTo={shipTo}
            addressBlock={addressBlock}
            panelOrder={panelOrder}
            panelDetail={panelDetail}
            toggleResidential={onToggleResidential}
            onEditRecipient={onEditRecipient}
            activeOrderLoading={activeOrderLoading}
            activeOrderError={activeOrderError}
          />
        </div>
    </>
  )
}
