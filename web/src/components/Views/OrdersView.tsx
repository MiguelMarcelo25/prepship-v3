import './OrdersView.css'
import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import HoverImage from '../HoverImage'
import type { NewOrderPayload } from '../NewOrderModal'
// Shared carrier badge — renders official UPS/USPS SVG logos plus
// fallback pills for FedEx/DHL/etc. Replaces the previous text-only
// carrier-badge spans throughout the orders table + side panel.
// PS-165: carrier/service/account display precedence owned by ./order-shipping-display (verbatim cascade).
// PS-166 (Wave 2a): the order-shipping-display resolvers are consumed by
// ./orders-display-state now (resolveDisplayServiceCode was already
// call-free here since PS-178's fallback deletion).
// PS-178 (Phase 6, part 2): row display readers extracted VERBATIM to ./orders-row-display
// (pure DTO readers — canonical model, best/selected rate fields, backend money tuple,
// the static v2 account registry, and the stateless row badges).
import {
  toRecord,
  toStringValue,
  toNumberValue,
  toProviderAccountId,
  getShippingModel,
  getBestRateWorkflowModel,
  getShippingString,
  getBestRateShippingProviderId,
  getBestRateServiceCode,
} from './orders-row-display'
// PS-166/PS-306 (decomposition): pure money/rate cell renderers extracted to OrdersRateCells.
import { renderOrderTotalCell, renderBestRateFinalCell, renderCShippingRateCell, renderMarketplaceFeeCell, renderProfitCell } from './orders-rate-cells'
// PS-166/PS-306/PS-258 (Wave 2): the four leaf cell renderers (Best Rate / Ship
// Margin / Carrier / Shipping Account) extracted VERBATIM to ./orders/cells/order-cells.
// renderTableCell stays here as a thin dispatcher; the component-scoped closures
// the leaves read are injected via the typed OrderCellsDeps DI object (orderCellsDeps).
import {
  renderBestRatePrice as renderBestRatePriceCell,
  renderMargin as renderMarginCell,
  renderCarrierCell as renderCarrierCellLeaf,
  renderShippingAccountCell as renderShippingAccountCellLeaf,
  type OrderCellsDeps,
} from './orders/cells/order-cells'
// PS-166: backend best-rate completeness reader, extracted to its own small file
// (pure backend-DTO read; PS-111 backend-owned completeness). Not coupled to
// buildRateRequestDraftKey (PS-143 — the FE draft key stays independent).
import { deriveBackendBestRateComplete } from './orders-rate-proof'
// PS-286: pure classifier that turns the backend rate SOT verdict (isComplete /
// cacheExpiresAt / eligibilityVersion, via savedBestRateCanDisplayForCurrentRequest)
// into an explicit Best-Rate-column state so a stale/incomplete/expired saved rate
// renders an actionable label instead of a confident dollar figure.
import {
  AWAITING_BEST_RATE_STATE_LABELS,
} from './awaiting-best-rate-display-state'
// PS-286 (slice): the Send-to-Queue preflight consumes the SAME explicit Awaiting
// verdict, so a stale/incomplete/expired/eligibility-mismatched saved rate is
// treated as NOT queueable-as-current (the queue can't silently buy a rate the
// Best Rate column is refusing to show as a dollar figure).
import { classifyPrintQueuePreflightFromAwaitingState } from './print-queue-preflight-state'
import { classifyPrintQueuePreflightForSavedRate } from './print-queue-preflight-saved-rate'
import {
  fetchRecalculateAllJob,
  fetchLatestRecalculateAllJob,
  isRecalculateAllJobDone,
  startFullLiveRecalculateAllBestRates,
  startRecalculateAllBestRates,
  summarizeRecalculateAllJob,
} from './orders-recalculate-all'
import { apiClient } from '../../api/client'
import { isDirectCarrierId } from '../../lib/v2-apiClient'
const OrderDetailDrawer = lazy(() => import('../OrderDetailDrawer'))
const NewOrderModal = lazy(() => import('../NewOrderModal'))
const RateBrowserModal = lazy(() => import('../RateBrowserModal'))
const TrackingModal = lazy(() => import('../TrackingModal'))
import { ToastContext } from '../../contexts/ToastContext'
import { useLocations, useOrderDetail, useOrders, useShippingAccounts } from '../../hooks'
import { api } from '../../lib/api'
// PS-135: canonical FE rate-proof helpers (extracted from this file; pure backend-DTO reads).
import {
  BACKEND_RATE_PROOF_SOURCE,
  hasBackendIssuedRateProof,
  rateProofFingerprint,
  rateBelongsToProviderAccount,
} from '../../lib/rate-proof'
import type {
  CreateLabelRequestDto,
  OrderFullDto,
  OrderPicklistResponseDto,
  OrderSummaryDto,
  PackageDto,
  PrintQueueEntryDto,
} from '../../types/api'
// PS-178 (Phase 6, part 3): the Print Queue drawer JSX lives in its own
// render-only component; OrdersView keeps all queue state + handlers.
// Lazy like the sibling drawers/modals above — the drawer chunk stays out of
// the initial bundle and loads on first queue open.
const OrdersPrintQueueDrawer = lazy(() =>
  import('./OrdersPrintQueueDrawer').then((module) => ({ default: module.OrdersPrintQueueDrawer })),
)
import { OrdersRecipientEditorModal } from './OrdersRecipientEditorModal'
// PS-178 (Phase 6, part 4): same pattern for the selected-rows toolbar.
import { OrdersSelectionToolbar } from './OrdersSelectionToolbar'
// PS-166 (Wave 1a): the persistent queue-job localStorage machinery moved
// VERBATIM to its own strict module (identifiers-only contract preserved —
// the ps-176 guard now pins it there).
import {
  attachPersistentQueueBackendJob,
  clearPersistentQueueJob,
  createPersistentQueueJob,
  getPersistentQueueJobProgress,
  markPersistentQueueJobOrder,
  readPersistentQueueJob,
  runWithConcurrency,
  yieldToBrowser,
  type PersistentQueueJob,
  type PersistentQueueJobKind,
  type PersistentQueueOrderRef,
} from './orders-persistent-queue-job'
// Batch-print pipeline: pure chain orchestration for the flag-ON "Create + Print Label"
// path (proof pre-pass → backend queue-send job → fade → merged-PDF print tail).
import { runCreatePrintChain } from './batch-create-print-chain'
import type { OrdersDateFilter } from './orders-view-filters'
import { resolveOrdersDateRangeForFilter } from './orders-date-query-contract'
// PS-258/PS-166: the Awaiting orders ORDER/sort computation lifted to a pure, testable owner.
// (buildSkuCompositionKey now lives only in orders-filtered-sort, where the sku-sort moved.)
// PS-166/PS-306/PS-258: pure filter/sort derivation memos extracted VERBATIM.
import { useOrdersFilterSort } from './hooks/useOrdersFilterSort'
import { useOrdersSelection } from './hooks/useOrdersSelection'
// PS-166/PS-258 (Hook wave 3): pure panel section-collapse UI state extracted VERBATIM.
import { usePanelState } from './hooks/usePanelState'
import { formatQueuedOrderToast, formatQueuedOrdersToast } from './orders-queue'
// PS-286: close the Rate-Browser-apply -> persist+refetch -> close race by awaiting
// the in-flight persist before the modal actually closes (exposes the row to Send).
import { trackAppliedRatePersist, awaitAppliedRatePersists } from './orders-applied-rate-sync'
import { useTableDensityPreference } from './orders-table-density-prefs'
import {
  buildDailyStripProgress,
  buildBatchRecalculateProgress,
  buildColumnPrefsForStatus,
  buildPicklistPrintHtml,
  buildQueueAddPayload,
  cachedNegativeNeedsLiveRetry,
  canRetryBatchRecalculateRow,
  classifyAwaitingRateCellStateWithWorkflow,
  groupPrintQueueEntries,
  planSettledAutoRate,
  resolveColumnPrefs,
  savedBestRateCanDisplayForCurrentRequest,
  resolveSkuDisplayLines,
  selectBatchRecalculateOrderIds,
  type AwaitingRateCellState,
  type AutoBestRateEntry,
  type BatchRecalculateRowState,
  type BatchRecalculateScope,
  type ColumnPrefs,
  type PrintQueueGroup,
  type ResolvedColumnPrefs,
  type TableColumnConfig,
} from './orders-parity'
import { readLocalColumnPrefs, writeLocalColumnPrefs } from './orders-column-prefs-local'
import { computeReorderedColumns } from './orders/column-reorder'
import { useColumnDrag } from './orders/useColumnDrag'
import { useColumnResize } from './orders/useColumnResize'
import { useRecipientEditor, type RecipientDraft } from './orders/useRecipientEditor'
import { useDailyStats } from './orders/useDailyStats'
import { useColumnMenu } from './orders/useColumnMenu'
import { useCsvExport } from './orders/useCsvExport'
import { useIsMobileViewport } from './orders/useIsMobileViewport'
import { useOrderBundles, useCombineShipments } from './orders/use-order-bundles'
import {
  buildFilteredAwaitingRecalculateQuery,
  formatBatchRecalculateFinishedMessage,
  prepareBatchRecalculateRows,
} from './awaiting-rate-recalculate'
import {
  getComboDefaultPackageId,
  getInitialPanelServiceCode,
  getInitialPanelShipAccountId,
  getMatchedPackageIdByDimensions,
  getPanelConfirmation,
  getPanelInsurance,
  getPanelPackageId,
  getPanelWarehouseId,
  getProductDefaultPackageId,
  type PanelFormState,
} from './orders-panel-state'
import { SHIPPING_SERVICE_ELIGIBILITY_VERSION, resolveEffectiveInsurance } from '../../../../src/lib/shipping-service-eligibility'
// PS-164: confirmation/insurance alias normalization is owned by src/lib/shipping-options (single
// source of truth). The FE delegation wrappers live in ./orders-rate-input (PS-166 Wave 1d) —
// this file consumes the wrappers and owns no alias maps.

// PS-166 (Wave 2a2): OrderStatus / SortKey (with its 2026-06-04 override
// citation) / TableColumnKey / TableColumn / TABLE_COLUMNS /
// getVisibleColumns / getSortValue moved VERBATIM to ./orders-table-columns.
import {
  TABLE_COLUMNS,
  type OrderStatus,
  type SortKey,
  type TableColumn,
  type TableColumnKey,
} from './orders-table-columns'

type SortDirection = 'asc' | 'desc'

interface QueueActionProgress {
  label: string
  completed: number
  total: number
  skipped: number
  failed: number
  startedAt: number
  tick: number
}

function formatQueueActionProgressDetail(progress: QueueActionProgress, elapsedSeconds: number): string {
  const issues = [
    progress.skipped > 0 ? `${progress.skipped} skipped` : null,
    progress.failed > 0 ? `${progress.failed} failed` : null,
  ].filter((issue): issue is string => Boolean(issue))

  return `${progress.completed}/${progress.total}${progress.completed < progress.total ? ` - working ${elapsedSeconds}s` : ''}${issues.length > 0 ? ` - ${issues.join(' - ')}` : ''}`
}

interface AllMatchingSelectionState {
  active: boolean
  scopeKey: string
  ids: number[]
  total: number
  truncated: boolean
  selectionLimit: number
}

const BATCH_RECALCULATE_TIMEOUT_MS = 45_000
const BATCH_RECALCULATE_CONCURRENCY = 3

// PS-166 W4c: PanelFormState moved to ./orders-panel-state (imported above as a
// type) so the extracted strict shipping-field components can share the shape.

// PS-166 (Wave 1d): the rate-input normalizers (confirmation/insurance
// delegation + PS-072 carrier inference) moved VERBATIM to
// ./orders-rate-input (strict module). The PS-164 delegation pins read the
// new home.
import {
  inferCarrierFromServiceCode,
  normalizeConfirmationForRates,
  normalizeInsuranceForRates,
} from './orders-rate-input'

// PS-166 (this slice): the pure panel/package dimension + shipment-key helpers
// (getPanelWeightOzFromForm / getPanelDimsFromForm / getShipmentDetailsKey /
// hasCompleteDims / getDimsKey / getPackageIdentifier / getPackageDims) plus the
// ShipmentDims shape moved VERBATIM to ./orders/panel-shipment-dims (pure, no
// state). Re-imported here; the state-closing getPanelWeightOz/getPanelDims
// wrappers below stay in the component and delegate to the *FromForm helpers.
import {
  getDimsKey,
  getPackageDims,
  getPackageIdentifier,
  getPanelDimsFromForm,
  getPanelWeightOzFromForm,
  getShipmentDetailsKey,
  hasCompleteDims,
  type ShipmentDims,
} from './orders/panel-shipment-dims'

// PS-166 (this slice): the pure FE rate-request key normalizers
// (normalizeRateZip / rateShipDateBucket) moved VERBATIM to
// ./orders/rate-request-normalizers. They feed buildRateRequestDraftKey, which
// stays in this component — PS-143: the FE draft key is NOT coupled to the
// backend response fingerprint; these are pure input-shaping helpers.
import {
  normalizeRateZip,
  rateShipDateBucket,
} from './orders/rate-request-normalizers'
// PS-317: pure Best-Rate helpers extracted to ./orders/best-rate/*.
import { getAppliedRateDims, getAppliedRateWeightOz, sanitizeRecalculateError } from './orders/best-rate/rate-values'
import { residentialForRate, buildRateRequestDraftKey, orderShippingHold } from './orders/best-rate/rate-request'
import { getBackendRateResponseFingerprint, withRateRequestMetadata, getSavedBestRateRecord, buildSelectedRateProofPayload, buildRateQuoteRefForOrder, getRateBaseAmount } from './orders/best-rate/rate-proof'
import { hasSavedBestRateForRequest, hasValidSavedBestRateForRequest, hasAnySavedBestRateForDisplay } from './orders/best-rate/rate-display-predicates'
import { createBestRateHelpers } from './orders/best-rate/rate-helpers'

interface OrdersViewProps {
  currentStatus: OrderStatus
  searchQuery?: string
  onSearchQueryChange?: (value: string) => void
  activeStore?: number | null
  dateFilter?: OrdersDateFilter
  onDateFilterChange?: (filter: OrdersDateFilter) => void
  onResolvedDateRangeChange?: (range: { start?: string; end?: string }) => void
  selectedOrderIds?: number[]
  onSelectedOrderIdsChange?: (ids: number[]) => void
  activeOrderId?: number | null
  onActiveOrderIdChange?: (id: number | null) => void
  onNavigateView?: (view: 'locations' | 'packages') => void
  columnMenuRequestId?: number
  labelsActionRequestId?: number
  queueToggleRequestId?: number
  onQueueStateChange?: (state: { count: number; isOpen: boolean }) => void
  refreshVersion?: number
  /**
   * Counter from Home — increments every time the user clicks a
   * sidebar entry (status or store). When it changes, OrdersView
   * clears its locally-owned filters (skuFilter + customDateFrom +
   * customDateTo). search + dateFilter are reset by Home directly
   * since they live in Home state.
   *
   * Counter (not boolean) so rapid clicks each produce a distinct
   * value — the watching useEffect can't miss an event due to
   * batching or a same-value setState skipping the dep change.
   */
  filterResetVersion?: number
  showTestOrders?: boolean
  includeInactiveClients?: boolean
  // User preference (from localStorage in Home.tsx) — when true, the
  // right-side order detail panel is hidden when no order is selected.
  // The panel still appears the moment a row is clicked (showing details).
  // Default false (panel always visible) for back-compat.
  hideEmptyPanel?: boolean
  // Callback fired when the user toggles hideEmptyPanel from inside the
  // panel itself (the × close button) or from the vertical edge tab
  // ("Show panel"). Updates the same localStorage-backed pref in Home.tsx.
  onHideEmptyPanelChange?: (hide: boolean) => void
  stores?: Array<{ storeId?: number | null; clientId?: number | null; storeName?: string | null; name?: string | null }>
}

// PS-258 (slice B): scheduleNonCriticalOrdersWork (the pure, closure-free
// idle-time scheduler) moved VERBATIM to ./orders-non-critical-scheduler
// (strict module). Imported below; the two call sites are unchanged.

// PS-258 (slice): the daily-stats rollover scheduling math (getDailyStats-
// RolloverParts, addCalendarDays, getTimeZoneOffsetMs, zonedDateToUtcDate, and
// the public getMsUntilNextDailyStatsRollover) moved VERBATIM to the strict
// (strictly-typed) ./daily-stats-rollover module. Pure functions, identical
// logic; the DAILY_STATS_ROLLOVER_* constants moved with them. The lone call
// site (the rollover-refresh effect) now reads the import.

// PS-189: the account→service catalog is BACKEND-owned (src/lib/carrier-service-
// catalog.ts, served at GET /carriers/service-catalog). The local CARRIER_SERVICES
// copy is deleted; getServiceOptionsForAccount reads the fetched catalog.

// PS-184: the legacy client-id parity maps are BACKEND-owned — every order row
// and detail payload carries `legacyClientId` stamped by resolveLegacyClientId
// (src/routes/orders.ts). The three FE remap tables that shadowed it (by display
// name / store id / current id) are deleted; getLegacyClientIdForDisplay passes
// the backend value through.

// PS-166 (#685): TEST_CARRIER_CODE + the test-mock rate-builder cluster moved to
// ./orders/test-rate-mock (its own small module). Re-imported below.
// PS-166 (this slice): TEST_SERVICE_CODE + TEST_SHIPPING_ACCOUNT_LABEL +
// buildTestMockRate also moved VERBATIM to ./orders/test-mock-rate-normalizer; re-imported below.
// PS-135: BACKEND_RATE_PROOF_SOURCE now imported from ../../lib/rate-proof (single source).
const RATE_PROOF_RETRY_MESSAGE = 'Rate changed or expired. Re-rate this order before creating the label.'
// PS-perf (DJ 2026-06-23): clearer message for the COMMON stale-saved-rate case (a saved rate
// aged past its validity window at queue/print time). The generic RATE_PROOF_RETRY_MESSAGE stays
// on the genuine "couldn't re-rate" failure branches inside refreshStaleRateForOrder; this one is
// used only where we immediately kick off the one-click re-rate (never auto-repurchases — PS-191).
const RATE_EXPIRED_RERATE_MESSAGE = 'Rate expired — re-rate this order before printing.'
const SHOPIFY_LABEL_PURCHASE_CONFIRM_MESSAGE =
  'Shopify does not provide the exact label price before purchase through the Admin API.\n\n' +
  'Shopify will buy the cheapest available Shopify Shipping label for this order. Continue?'
const BATCH_QUEUE_CONCURRENCY = 2
const BACKEND_QUEUE_SEND_POLL_MS = 750

// PS-258 (slice): getQueueableLabelUrl + getQueuePayloadEntries (the two pure
// print-queue payload parsers) moved VERBATIM to ./orders-queue-parsers (strict
// module). Imported above; call sites below are unchanged.
// Per user override unlock shipped data on 2026-05-23: queue/recovery paths must reject corrupt saved label URLs without weakening shipped/cancelled edit locks.

// PS-166 (Wave 1b): the pure display formatters (dates/weight/age/palette/
// carrier/service + truncate) moved VERBATIM to ./orders-formatting (strict
// module). CALIFORNIA_TZ + californiaDateInputValue stay imported here for
// the component body's direct uses (CSV filename, picklist timestamp,
// delivered-date render).
import { californiaDateInputValue, CALIFORNIA_TZ } from '../../lib/ca-time'
// PS-258 (slice): pure print-queue payload parsers (strict module).
import { getQueueableLabelUrl, getQueuePayloadEntries } from './orders-queue-parsers'
// PS-258 (slice B): pure idle-time non-critical scheduler (strict module).
import { scheduleNonCriticalOrdersWork } from './orders-non-critical-scheduler'
// PS-166 (#685): the pure test-mock rate-builder cluster (deterministic synthetic
// rates for the local prepship_test carrier) moved VERBATIM into the orders/
// package directory. TEST_CARRIER_CODE re-imported (still used widely in the body).
import {
  TEST_CARRIER_CODE,
  buildBestTestRateForShipment,
  buildTestRateBrowserAccounts,
} from './orders/test-rate-mock'
// PS-166 (this slice): buildTestMockRate + TEST_SERVICE_CODE +
// TEST_SHIPPING_ACCOUNT_LABEL moved VERBATIM to their own small file.
import {
  TEST_SERVICE_CODE,
  buildTestMockRate,
} from './orders/test-mock-rate-normalizer'
import {
  ageLabel,
  formatDateTime,
  formatLabelCreated,
  formatWeight,
  getAgeColor,
  getClientPalette,
  truncate,
} from './orders-formatting'
// PS-166 (Wave 1c): the pure item/order/ship-to accessors (normalizeItems →
// getDimensions, incl. isTestOrder/isBackendTestOrder and the TEST_PACK_*
// constants) moved VERBATIM to ./orders-items (strict module). The ps-186
// money-path pin (isBackendTestOrder definition) now reads that module; its
// call-shape pins still read this file.
import {
  getActiveItems,
  getDimensions,
  getMergedItems,
  getOrderWeightOz,
  getShipTo,
  getShipToLine,
  getTotalQuantity,
  isBackendTestOrder,
  isEbayOrder,
  isTestOrder,
} from './orders-items'
// PS-166 (Wave 2a): the shipped/cancelled/awaiting display-state + badge
// resolvers (PS-036/056 three-state classification, PS-165 display
// precedence, PS-048 shipped diagnostics, PS-038 expedited, copyText) moved
// VERBATIM to ./orders-display-state. Definition pins read the new home;
// every call site below is unchanged.
import {
  copyText,
  getExpeditedBadge,
} from './orders-display-state'

// PS-166 (Wave 2a3): buildEmptyPanel → ./orders-empty-panel (verbatim JSX);
// runWithConcurrency → ./orders-persistent-queue-job (lives with
// yieldToBrowser, which paces it); useDebouncedValue → ../../hooks (generic).
import { buildEmptyPanel } from './orders-empty-panel'
// PS-166/PS-306/PS-258 (Wave 4): the filter/batch/export toolbar (the
// `<div id="filterbar">` block) moved VERBATIM to <OrdersFilterToolbar>.
// PRESENTATIONAL — every async handler stays a parent closure threaded down.
import { OrdersFilterToolbar } from './OrdersFilterToolbar'
// PS-166 (Wave 2d): the batch-actions panel (2+ selected) moved VERBATIM to
// a strict <OrdersBatchPanel> component; OrdersView passes its ~28 state +
// handler props. The isReadOnly lockdown guard rides inside (R5).
import { OrdersBatchPanel } from './OrdersBatchPanel'
// PS-166/PS-306/PS-258 (Wave 3): the loading / error / results-gating framing
// around the orders table moved VERBATIM to a strict presentational
// <OrdersResultsShell> (no state; gating booleans + display values + onRetry
// are passed in; it embeds <OrdersResultsEmptyState>). The <table id="ordersTable">
// is passed in as children (the table slot) — in Wave 6 that child became the
// extracted <OrdersTable>. Byte-identical markup; control flow unchanged.
import { OrdersResultsShell } from './OrdersResultsShell'
// PS-166/PS-306/PS-258 (Wave 6): the orders TABLE (thead + tbody, incl. the
// <colgroup>, sortable/draggable/resizable column headers, and the dual
// flat/sku-grouped row-map) moved VERBATIM to a strict presentational
// <OrdersTable>. The per-cell dispatcher renderTableCell stays HERE and is
// threaded in as renderCell; every header/row/group handler stays HERE and
// flows down as props. Byte-identical #ordersTable/#tableHead/#ordersBody
// markup (test:orders-dom-parity:browser proves no drift).
import { OrdersTable } from './OrdersTable'
// PS-166 (Wave 3, JSX-safe): the daily-stats strip JSX moved VERBATIM to a
// strict <OrdersDailyStrip> (state/effects/rollover stay in OrdersView).
import { OrdersDailyStrip } from './OrdersDailyStrip'
// PS-166 (Wave 3b, JSX-safe): the side-panel Items + Recipient display
// sections moved VERBATIM to strict presentational components (collapse,
// residential toggle, copy, toasts stay as OrdersView callbacks/state).
// PS-166 W4: leaf presentational rows of the side-panel Shipping section.
// PS-166/PS-306/PS-258 (Wave 5): the order-detail SIDE PANEL (former
// renderSinglePanel) moved VERBATIM to a strict presentational
// <OrdersDetailSidePanel>. PRESENTATIONAL — every backend-truth handler (Ship
// Acct PS-189/PS-204 + setOrderSelectedPid, Package precedence +
// setOrderSelectedPackageId, Confirmation/Insurance refreshPanelBestRate,
// createOrQueueLabel / recalculateBestRate / saveShipmentDetails / reprintLabel)
// stays PARENT-OWNED here and is threaded down as an on* callback; the leaf
// holds no apiClient / selected-pid/package persistence / label-purchase logic.
import { OrdersDetailSidePanel } from './OrdersDetailSidePanel'
// PS-219: shared danger-tone confirm dialog for the operator Void Label action.
import { ConfirmModal } from '../ui/ConfirmModal'
// PS-276 (slice 4-UI): compact resi/comm tag on the Orders table customer cell (display-only).
import { ResidentialTag, residentialTagFacts } from '../ui/ResidentialTag'
// PS-166 (Wave 2c1): the two leaf cell renderers (Order # cell + generic
// diagnostic cell) moved VERBATIM to ./OrdersTableCells; renderTableCell
// (still here) calls renderOrderCell with an explicit context object.
import { renderDiagnosticColumnCell, renderOrderCell } from './OrdersTableCells'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'

// Module-scope so the queue-scope-mismatch branch keeps a stable identity
// across renders (a fresh [] would bust every queue-derivation memo below).
const EMPTY_QUEUE_ENTRIES: PrintQueueEntryDto[] = []

export default function OrdersView({
  currentStatus,
  searchQuery = '',
  onSearchQueryChange,
  activeStore,
  dateFilter = '',
  onDateFilterChange,
  onResolvedDateRangeChange,
  selectedOrderIds = [],
  onSelectedOrderIdsChange,
  activeOrderId = null,
  onActiveOrderIdChange,
  onNavigateView,
  columnMenuRequestId = 0,
  labelsActionRequestId = 0,
  queueToggleRequestId = 0,
  onQueueStateChange,
  refreshVersion = 0,
  filterResetVersion = 0,
  showTestOrders = true,
  includeInactiveClients = false,
  hideEmptyPanel = false,
  onHideEmptyPanelChange,
  stores = [],
}: OrdersViewProps) {
  const toastContext = useContext(ToastContext)
  const queryClient = useQueryClient()
  // Order assignment: only admins can assign orders to other users. Workers
  // see only their own assigned rows (server-side filter; this flag just
  // controls visibility of the admin-only UI).
  // Recalculate All — one backend backfill job over every awaiting order; the
  // whole feature lives in ./orders-recalculate-all (kept out of this file by
  // design). Rows light up pending/rating via PS-120 while it runs.
  const [recalcAllJobId, setRecalcAllJobId] = useState<string | null>(null)
  const [recalcAllSummary, setRecalcAllSummary] = useState<string | null>(null)
  async function handleRecalculateAll() {
    try {
      recalcAllUserInitiatedRef.current = true
      const { jobId } = await startRecalculateAllBestRates()
      setRecalcAllJobId(jobId)
      setRecalcAllSummary('starting…')
    } catch (error) {
      recalcAllUserInitiatedRef.current = false
      showToast(error instanceof Error ? error.message : 'Failed to start Recalculate All', 'error')
    }
  }
  async function handleFullLiveRecalculateAll() {
    try {
      recalcAllUserInitiatedRef.current = true
      const { jobId } = await startFullLiveRecalculateAllBestRates()
      setRecalcAllJobId(jobId)
      setRecalcAllSummary('full live audit starting...')
    } catch (error) {
      recalcAllUserInitiatedRef.current = false
      showToast(error instanceof Error ? error.message : 'Failed to start Full Live Recalculate', 'error')
    }
  }
  useEffect(() => {
    if (!recalcAllJobId) return
    let cancelled = false
    let refreshInflight = false
    let recalcAllPollFailures = 0
    const settleTimers: ReturnType<typeof setTimeout>[] = []
    const timer = setInterval(async () => {
      try {
        const job = await fetchRecalculateAllJob(recalcAllJobId)
        if (cancelled) return
        recalcAllPollFailures = 0
        // PS-345 follow-up: this poller handles operator-started Recalculate All AND backend/sync-started
        // rate backfill jobs discovered through /rates/backfill-best/latest. It only observes/refetches;
        // it never starts hidden frontend live-rate work.
        if (recalcAllUserInitiatedRef.current) setRecalcAllSummary(summarizeRecalculateAllJob(job))
        if (isRecalculateAllJobDone(job)) {
          setRecalcAllJobId(null)
          recalcAllUserInitiatedRef.current = false
          if (job.failed) {
            showToast(`Recalculate All finished — ${summarizeRecalculateAllJob(job)}`, 'error')
          }
          setRecalcAllSummary(null)
          await refetchOrders()
          // RC5 settle-poll: the backend finalizes the last rows from a few ms up to a couple MINUTES after
          // the job reports done — a slow/retried ShipStation carrier (RC1) can land a rate well after the
          // job's last worker. So keep refetching on a BOUNDED schedule out to ~2.7min so EVERY row fills in
          // on its own and the user never has to reload the page. Bounded + cancellable; it only observes
          // the existing job and never starts another rate job.
          for (const delay of [3000, 8000, 16000, 24000, 36000, 50000, 70000, 95000, 125000, 160000]) {
            settleTimers.push(setTimeout(() => { if (!cancelled) void refetchOrdersRef.current?.() }, delay))
          }
          return
        }
        // Mid-job row refresh: the backfill stamps each order pending → rating →
        // resolved (PS-120), and the /orders payload carries that state. Refetch
        // while the job runs so rows show the live recalculating spinner and each
        // best rate appears as soon as its order resolves — not only at the end.
        if (!refreshInflight) {
          refreshInflight = true
          void refetchOrders().finally(() => { refreshInflight = false })
        }
      } catch {
        if (cancelled) return
        recalcAllPollFailures += 1
        if (recalcAllPollFailures >= 3) {
          setRecalcAllJobId(null)
          recalcAllUserInitiatedRef.current = false
          setRecalcAllSummary('status unavailable')
          showToast('Recalculate All status unavailable — refresh and retry if needed', 'error')
          setTimeout(() => setRecalcAllSummary(null), 8000)
        }
      }
    }, 2500)
    return () => { cancelled = true; clearInterval(timer); settleTimers.forEach(clearTimeout) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalcAllJobId])

  useEffect(() => {
    if (currentStatus !== 'awaiting_shipment' || recalcAllJobId) return
    let cancelled = false
    async function attachLatestRateBackfillJob() {
      try {
        const job = await fetchLatestRecalculateAllJob()
        if (cancelled || !job) return
        if (job.status === 'pending' || job.status === 'running' || job.status === 'queued') {
          recalcAllUserInitiatedRef.current = false
          setRecalcAllJobId(job.jobId)
        }
      } catch {
        // Read-only observer. A transient status miss must not block the orders table.
      }
    }
    void attachLatestRateBackfillJob()
    const timer = setInterval(() => { void attachLatestRateBackfillJob() }, 15_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [currentStatus, recalcAllJobId])

  // PS-181: admin identity is BACKEND-owned — GET /users/me answers via the canonical
  // isAdminEmail (src/lib/admin-emails.ts). The FE never hardcodes admin emails and
  // defaults to non-admin until the backend answers (the server still enforces every
  // admin-only route regardless of this display flag).
  const [callerIsAdmin, setCallerIsAdmin] = useState(false)
  useEffect(() => {
    let cancelled = false
    void api.get<{ id: string | null; email: string | null; isAdmin: boolean }>('/users/me')
      .then((res) => {
        if (cancelled) return
        setCallerIsAdmin(res.isAdmin === true)
      })
      .catch((err) => console.warn('[orders] failed to load caller identity:', err))
    return () => { cancelled = true }
  }, [])
  type AssignableUser = { id: string; email: string; isAdmin: boolean }
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([])
  const [assignTo, setAssignTo] = useState<string>('')  // userId or '' (none) or 'unassign'
  const [assignBusy, setAssignBusy] = useState(false)
  const [allMatchingSelection, setAllMatchingSelection] = useState<AllMatchingSelectionState | null>(null)
  const [selectingAllMatching, setSelectingAllMatching] = useState(false)
  const [selectedOrderSnapshots, setSelectedOrderSnapshots] = useState<Map<number, OrderSummaryDto>>(() => new Map())
  useEffect(() => {
    if (!callerIsAdmin) return
    let cancelled = false
    void api.get<{ users: AssignableUser[] }>('/users')
      .then((res) => {
        if (cancelled) return
        setAssignableUsers(res.users ?? [])
      })
      .catch((err) => console.warn('[orders] failed to load assignable users:', err))
    return () => { cancelled = true }
  }, [callerIsAdmin])
  const [page, setPage] = useState(1)
  // Page-size selector — operator picks how many rows per page from a
  // small set. Persisted to localStorage so it survives reloads. The
  // value is read once on first render and clamped to the allowed
  // options (defends against a stale localStorage value if we ever
  // change the option set). 50 is the default, matching the prior
  // hardcoded behavior so no operator sees a sudden density change.
  //
  // 2026-05-12: trimmed the option set to {5, 20, 50, 100, 200} per
  // boss directive. The previous high-cap options (500/1000/2000)
  // were retired — at those sizes the browser struggled with DOM
  // size and operators rarely needed more than 200 visible at once.
  // Returning users who had 1000/2000 saved fall back to the 50
  // default on next load because the clamp below rejects unknown
  // values.
  //
  // Per user override unlock shipped data on 2026-06-03: removed the
  // small 5 and 20 per-page options from the Orders pagination
  // (Awaiting Shipment / Shipped / Cancelled) per operator request.
  // Anyone who had 5 or 20 saved in localStorage falls back to 50
  // automatically via the ALLOWED_PAGE_SIZES.includes() clamp below.
  // Display-only: no shipped/cancelled data, isReadOnly gating, or
  // batch-mutation behavior changed.
  const ALLOWED_PAGE_SIZES = [50, 100, 200] as const
  const PAGE_SIZE_STORAGE_KEY = 'prepship_orders_page_size'
  const [pageSize, setPageSize] = useState<number>(() => {
    if (typeof window === 'undefined') return 50
    const raw = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY)
    const parsed = Number(raw)
    return ALLOWED_PAGE_SIZES.includes(parsed as (typeof ALLOWED_PAGE_SIZES)[number])
      ? parsed
      : 50
  })
  // When operator changes page size, reset to page 1. Without this they
  // could pick "200" while sitting on page 4 of a 50-per-page list and
  // end up out-of-bounds (page 4 of a 1-page result = empty list).
  const updatePageSize = (size: number) => {
    setPageSize(size)
    setPage(1)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size))
    }
  }
  const [skuFilter, setSkuFilter] = useState('')
  const [customDateFrom, setCustomDateFrom] = useState('')
  const [customDateTo, setCustomDateTo] = useState('')
  const [sortState, setSortState] = useState<{ key: SortKey; dir: SortDirection }>({ key: 'date', dir: 'desc' })
  const [skuSortActive, setSkuSortActive] = useState(false)
  const [preSkuSortSnapshot, setPreSkuSortSnapshot] = useState<number[] | null>(null)
  // PS-166/PS-258 (Hook wave 3): collapsedSections + toggleSection now live in
  // usePanelState (pure panel-UI state). Destructured here at the same location;
  // the panel pass-through (collapsedSections / onToggleSection) is unchanged.
  const { collapsedSections, toggleSection } = usePanelState()
  const [packages, setPackages] = useState<PackageDto[]>([])
  const [packagesLoaded, setPackagesLoaded] = useState(false)
  const [columnPrefs, setColumnPrefs] = useState<ColumnPrefs | null>(null)
  // PS-317: column-visibility dropdown UI state lives in useColumnMenu.
  const { columnMenuOpen, setColumnMenuOpen, columnMenuPos, columnMenuRef } = useColumnMenu(columnMenuRequestId)
  // New manual-order modal — opens via the +New Order button beside
  // Export CSV. Backend route /orders/manual is pending; the save
  // handler currently shows a stub success toast so the UI flow is
  // reviewable in isolation.
  const [newOrderOpen, setNewOrderOpen] = useState(false)
  const isMobileViewport = useIsMobileViewport()
  // PS-317: column drag state + handlers live in useColumnDrag; the resize state + handlers live in
  // useColumnResize (both called below, after the shared suppressHeaderClickRef/resizeStateRef they
  // need are declared).
  const [queueOpen, setQueueOpen] = useState(false)
  const [queueHistoryVisible, setQueueHistoryVisible] = useState(false)
  // Print Queue panel: free-text filter for both active queue + history list,
  // plus sort direction for the printed-history list (newest first by default).
  const [pqSearch, setPqSearch] = useState('')
  const [pqHistoryAsc, setPqHistoryAsc] = useState(false)
  // Print Queue per-client view filter. The queue fetch stays 'all' scope (every AUTHORIZED
  // client's entries, each carrying client_id), so this is a pure client-side display filter:
  // null = show all clients, a clientId = show only that client. Backend scope is unchanged.
  const [pqClientFilter, setPqClientFilter] = useState<number | null>(null)
  const [queueEntries, setQueueEntries] = useState<PrintQueueEntryDto[]>([])
  const [queueEntriesClientId, setQueueEntriesClientId] = useState<number | null>(null)
  const [queueLoading, setQueueLoading] = useState(false)
  const [queueActionProgress, setQueueActionProgress] = useState<QueueActionProgress | null>(null)
  const [queuePrintMessage, setQueuePrintMessage] = useState<string | null>(null)
  const [queuePrintProgress, setQueuePrintProgress] = useState<number | null>(null)
  const [queuePrintInFlight, setQueuePrintInFlight] = useState(false)
  const [queuePrintReadyEntryIds, setQueuePrintReadyEntryIds] = useState<Set<string>>(new Set())
  const [rateBrowserOpen, setRateBrowserOpen] = useState(false)
  const [detailDrawerOrderId, setDetailDrawerOrderId] = useState<number | null>(null)
  const [detailDrawerFromQueue, setDetailDrawerFromQueue] = useState(false)
  const [trackingModal, setTrackingModal] = useState<{
    tracking: string
    carrierCode: string | null
  } | null>(null)
  const [rateBrowserLoading, setRateBrowserLoading] = useState(false)
  const [rateBrowserRates, setRateBrowserRates] = useState<Array<Record<string, unknown>>>([])
  const [printMenuOpen, setPrintMenuOpen] = useState(false)
  const [batchMenuOpen, setBatchMenuOpen] = useState(false)
  const [extShipMenuOpen, setExtShipMenuOpen] = useState(false)
  // Separate open-state for the BATCH Mark-as-Shipped popover (in the
  // batch panel that appears when 2+ orders are selected). Reuses the
  // same notify toggles + tracking state below as the single-order
  // popover, but its visibility is independent so opening one doesn't
  // close the other.
  const [batchExtShipMenuOpen, setBatchExtShipMenuOpen] = useState(false)
  // External-shipped popover form state. The popover is a small inline
  // form (toggles + tracking) instead of the previous bare list of
  // marketplaces, so the user can opt into Notify Customer / Notify
  // Marketplace at the same moment they pick the marketplace.
  //
  // Defaults match what most operators want: notify the marketplace
  // (so Amazon/eBay close the loop) but DON'T email the customer
  // (the marketplace's own status email gets there first and an
  // extra one looks redundant).
  const [extShipNotifyCustomer, setExtShipNotifyCustomer] = useState(false)
  const [extShipNotifyMarketplace, setExtShipNotifyMarketplace] = useState(true)
  const [extShipTracking, setExtShipTracking] = useState('')
  const [extShipBusy, setExtShipBusy] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchTestMode, setBatchTestMode] = useState(false)
  // Set of orderIds that just successfully shipped — they render with
  // Per-order print-label transition (boss directive 2026-05-07):
  // Continuous 30-second fade animation on the row (CSS keyframe
  // `ps-shipping-fade` in app-shell.css). The fade runs for the FULL
  // 30 seconds — not just at the end — so the operator visibly sees
  // the order leaving the awaiting list and "going to shipped". A
  // green "Shipping…" pill animates inline next to the order number
  // throughout to signal the action is in progress.
  //
  // At t=30 s the timer fires `refetchOrders()`. Backend already has
  // the order as 'shipped' (per order-sync race fix in 1afe757) so
  // the refresh drops the row from the awaiting list naturally.
  const [transitionalShippedIds, setTransitionalShippedIds] = useState<Set<number>>(new Set())
  const transitionalTimeoutsRef = useRef<Map<number, number>>(new Map())
  const transitionalRefetchTimerRef = useRef<number | null>(null)
  const lastHandledRefreshVersionRef = useRef(0)
  // Tracks which order# pill in the batch panel was just copied. Set on
  // click, cleared after ~1.2s so the pill flashes a "Copied!" check
  // and reverts. Single string at a time — clicking another pill
  // immediately replaces the previous flash.
  const [copiedOrderNum, setCopiedOrderNum] = useState<string | null>(null)
  const [copiedAll, setCopiedAll] = useState(false)
  // PS-258 (slice C): row-density preference extracted VERBATIM to
  // useTableDensityPreference (orders-table-density-prefs.ts) — pure localStorage
  // hook, byte-identical (same key, default 'cozy', validation set).
  const [tableDensity, setTableDensity] = useTableDensityPreference()

  const [singleActionBusy, setSingleActionBusy] = useState(false)
  const singleActionBusyRef = useRef(false)
  const [shipmentDetailsSaving, setShipmentDetailsSaving] = useState(false)
  const queueActionProgressTimerRef = useRef<number | null>(null)
  const queueActionHeartbeatTimerRef = useRef<number | null>(null)
  const activePersistentQueueJobIdRef = useRef<string | null>(null)
  const resumePersistentQueueJobIdRef = useRef<string | null>(null)
  const lastSelectionAnchorRef = useRef<number | null>(null)
  const shiftHeldOnMouseDownRef = useRef(false)
  // PS-219 (per user override unlock shipped data on 2026-06-13): operator Void
  // Label confirm state. voidConfirm holds the BACKEND-stamped local shipment id
  // + display facts; voidBusy gates the in-flight mutation. No optimistic local
  // void — the row only leaves Shipped after a 200 success refetch.
  const [voidConfirm, setVoidConfirm] = useState<{ shipmentId: number; voidability: any; order: OrderSummaryDto } | null>(null)
  const [voidBusy, setVoidBusy] = useState(false)
  const [panelForm, setPanelForm] = useState<PanelFormState>({
    locationId: '',
    shipAccountId: '',
    serviceCode: '',
    weightLb: '',
    weightOz: '',
    length: '',
    width: '',
    height: '',
    packageId: '',
    confirmation: 'none',
    insurance: 'none',
    insuranceValue: '',
  })
  const [panelRatePreview, setPanelRatePreview] = useState<Array<Record<string, unknown>>>([])
  const [panelRateLoading, setPanelRateLoading] = useState(false)
  const resolvedColumnPrefsRef = useRef<ResolvedColumnPrefs | null>(null)
  const columnPrefsRef = useRef<ColumnPrefs | null>(null)
  const currentStatusRef = useRef(currentStatus)

  // ─── SHIPPED / CANCELLED LOCKDOWN — DISABLED ──────────────────────
  // Per user override `unlock shipped data` on 2026-05-06: the
  // Shipped / Cancelled UI lockdown has been disabled. Checkboxes,
  // Select All, SKU-group select, and the batch actions panel are
  // re-enabled in those views.
  //
  // Defense-in-depth still applies at the BACKEND:
  //   • src/routes/orders.ts — every modification endpoint guards
  //     with assertOrderEditable() which rejects shipped/cancelled
  //     orders with HTTP 409 unless ?force=1&admin=true is passed.
  //   • src/services/fulfillment-deductions.ts — both deduction
  //     paths gated by isInventoryAutoDeductEnabled() kill switch.
  // So even if the user batch-clicks Print Labels on shipped orders,
  // the API will reject the call. The UI just no longer hides the
  // entry point.
  //
  // To re-enable the UI lockdown, change the right-hand side back to
  //   currentStatus === 'shipped' || currentStatus === 'cancelled'
  // and the five consumer sites (search isReadOnly) will gate again.
  const isReadOnly = false
  const resizeStateRef = useRef<{ key: TableColumnKey; startX: number; startWidth: number } | null>(null)
  const suppressHeaderClickRef = useRef(false)
  // PS-317: column drag-to-reorder interaction (4 state vars + 8 header/dropdown drag handlers),
  // extracted to useColumnDrag. moveColumn is a hoisted fn below; reorder math is unit-guarded
  // (ps-317-column-reorder). Resize/sort stay in OrdersView (they share these refs + sort state).
  const {
    dragColumnKey,
    dragOverColumnKey,
    dropdownDragColumnKey,
    dropdownDragOverColumnKey,
    handleHeaderDragStart,
    handleHeaderDragOver,
    handleHeaderDrop,
    finishHeaderDrag,
    handleDropdownDragStart,
    handleDropdownDragOver,
    handleDropdownDrop,
    finishDropdownDrag,
  } = useColumnDrag({ moveColumn, suppressHeaderClickRef, resizeStateRef })
  // PS-317 (Phase 3): column RESIZE interaction (resizing state + the document mousemove/mouseup
  // drag-resize effect + keyboard resize + the mouse-down starter), extracted to useColumnResize.
  // Shares resizeStateRef + suppressHeaderClickRef with useColumnDrag; the prefs helpers below stay
  // the canonical owner. handleHeaderKeyDown stays here (it also does reorder + sort) and delegates
  // the resize case to this resizeColumnByKeyboard.
  const { resizingColumnKey, startColumnResize, resizeColumnByKeyboard } = useColumnResize({
    getLatestColumnPrefs,
    buildSavedColumnPrefs,
    saveColumnPrefsToServer,
    setColumnPrefs,
    columnPrefsRef,
    currentStatusRef,
    suppressHeaderClickRef,
    resizeStateRef,
  })
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null)
  const autoPackageDimsKeyRef = useRef<string | null>(null)
  const panelFormInitKeyRef = useRef<string | null>(null)
  const panelRateSelectionSyncKeyRef = useRef<string | null>(null)
  const shipmentAutoSaveTimerRef = useRef<number | null>(null)
  const shipmentLastSavedKeyRef = useRef<string | null>(null)
  const bestRateRefreshSeqRef = useRef(0)
  const [autoBestRateEntries, setAutoBestRateEntries] = useState<Record<number, AutoBestRateEntry>>({})
  const [batchRecalculateRows, setBatchRecalculateRows] = useState<Record<number, BatchRecalculateRowState>>({})
  const [batchRecalculateBusy, setBatchRecalculateBusy] = useState(false)
  const batchRecalculateRunRef = useRef(0)
  const batchRecalculateProgress = useMemo(
    () => buildBatchRecalculateProgress(batchRecalculateRows),
    [batchRecalculateRows],
  )
  // Distinguishes a MANUAL Recalculate All click (operator wants a visible spinner + progress chip)
  // from future non-UI callers. Set true ONLY in handleRecalculateAll; gates the chip/spinner.
  const recalcAllUserInitiatedRef = useRef(false)
  // Tracks whether the user has *manually* edited weight or any dim in the
  // panel since the current order was loaded. The auto-rate-refresh effect
  // only fires when this is true. Reset to false whenever panelOrderId
  // changes, set to true inside the panel input onChange handlers.
  // Without this, simply clicking an order seeds weight/dims into the form
  // (in a render cycle separate from the orderId change), trips the effect's
  // deps, and fires an unwanted /rates fetch.
  const dimsUserEditedRef = useRef(false)

  const clearQueueActionProgressTimer = () => {
    if (queueActionProgressTimerRef.current == null) return
    window.clearTimeout(queueActionProgressTimerRef.current)
    queueActionProgressTimerRef.current = null
  }

  const clearQueueActionHeartbeatTimer = () => {
    if (queueActionHeartbeatTimerRef.current == null) return
    window.clearInterval(queueActionHeartbeatTimerRef.current)
    queueActionHeartbeatTimerRef.current = null
  }

  const startQueueActionHeartbeat = () => {
    clearQueueActionHeartbeatTimer()
    queueActionHeartbeatTimerRef.current = window.setInterval(() => {
      setQueueActionProgress((current) => current ? { ...current, tick: current.tick + 1 } : current)
    }, 1000)
  }

  const startQueueActionProgress = (total: number, label = 'Sending to queue', completed = 0, failed = 0, skipped = 0) => {
    clearQueueActionProgressTimer()
    startQueueActionHeartbeat()
    setQueueActionProgress({
      label,
      completed: Math.min(Math.max(total, 1), Math.max(completed, 0)),
      total: Math.max(total, 1),
      skipped: Math.max(skipped, 0),
      failed: Math.max(failed, 0),
      startedAt: Date.now(),
      tick: 0,
    })
  }

  const setQueueActionProgressLabel = (label: string) => {
    setQueueActionProgress((current) => current ? { ...current, label } : current)
  }

  const advanceQueueActionProgress = (failedDelta = 0, completedDelta = 1) => {
    setQueueActionProgress((current) => current
      ? {
        ...current,
        completed: Math.min(current.total, current.completed + completedDelta),
        failed: current.failed + failedDelta,
        skipped: current.skipped,
        tick: current.tick + 1,
      }
      : current
    )
  }

  const finishQueueActionProgress = (label: string, options: { complete?: boolean } = {}) => {
    setQueueActionProgress((current) => current
      ? { ...current, label, completed: options.complete === false ? current.completed : current.total }
      : current
    )
    clearQueueActionProgressTimer()
    clearQueueActionHeartbeatTimer()
    queueActionProgressTimerRef.current = window.setTimeout(() => {
      setQueueActionProgress(null)
      queueActionProgressTimerRef.current = null
    }, 2200)
  }

  useEffect(() => {
    return () => {
      clearQueueActionProgressTimer()
      clearQueueActionHeartbeatTimer()
      // Clean up any in-flight transitional-shipped timers so they
      // don't fire after unmount (would update state on a dead
      // component). Single 30s timer per order in the new design.
      for (const t of transitionalTimeoutsRef.current.values()) {
        window.clearTimeout(t)
      }
      transitionalTimeoutsRef.current.clear()
      if (transitionalRefetchTimerRef.current !== null) {
        window.clearTimeout(transitionalRefetchTimerRef.current)
        transitionalRefetchTimerRef.current = null
      }
    }
  }, [])

  function beginPersistentQueueJob(
    kind: PersistentQueueJobKind,
    jobOrders: OrderSummaryDto[],
    options: { label?: string; batchTestMode?: boolean } = {},
  ) {
    const job = createPersistentQueueJob(kind, jobOrders, options)
    activePersistentQueueJobIdRef.current = job.id
    startQueueActionProgress(job.total, job.label)
    return job.id
  }

  function finishPersistentQueueJob(jobId: string | null | undefined) {
    if (jobId) clearPersistentQueueJob(jobId)
    if (activePersistentQueueJobIdRef.current === jobId) {
      activePersistentQueueJobIdRef.current = null
    }
  }

  const dateRange = resolveOrdersDateRangeForFilter(dateFilter, {
    start: customDateFrom,
    end: customDateTo,
  })

  // PS-317: the Export CSV action lives in useCsvExport.
  const { csvExporting, handleExportCsv } = useCsvExport({ currentStatus, dateRange, showToast })

  // Hide Test Orders client across every status tab (Awaiting / Shipped /
  // Cancelled), not just Awaiting. Toggle in the sidebar still controls the
  // override. Only suppressed when no specific store is selected — viewing
  // the Test Orders client directly always shows its rows.
  const hideTestOrdersInAllAwaiting =
    activeStore == null && !showTestOrders
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 350)

  // PS-210: a non-empty search is a GLOBAL read — the backend widens the
  // status filter across awaiting/shipped/cancelled (searchScope=global) and
  // the store-sidebar scoping is dropped, exactly matching what the
  // bulk-selection matcher (matchingSelectionQuery below) has always done, so
  // the visible table and Select-All-Matching can no longer disagree. Date
  // and Hide-Test filters intentionally still apply (the search pill says
  // so). Clearing the box restores plain tab-local behavior.
  const isGlobalSearchActive = debouncedSearchQuery.trim().length > 0
  const { orders, total, totalApproximate, pages, currentPage, loading, refreshing, error, refetch: refetchOrders } = useOrders(currentStatus, {
    page,
    pageSize,
    storeId: isGlobalSearchActive ? undefined : activeStore ?? undefined,
    dateStart: dateRange.start,
    dateEnd: dateRange.end,
    hideTestOrders: hideTestOrdersInAllAwaiting,
    includeInactiveClients,
    search: debouncedSearchQuery,
    searchScope: isGlobalSearchActive ? 'global' : undefined,
    sortBy: skuSortActive ? 'sku' : undefined,
    // Forwarded so the backend filters by SKU exactly. Replaces the
    // old client-side filter (now removed below) which only ran over
    // the current paginated page and missed matches on later pages.
    sku: skuFilter,
  })
  // PS-218: an Orders search is "in flight" in two windows the table must not
  // mistake for "no results": (1) the debounce gap — the user has typed but
  // debouncedSearchQuery (the query key) hasn't caught up yet; and (2) the
  // server fetch — React Query keeps the previous page as placeholderData, so
  // `loading` stays false while the new search request is running. In both
  // windows the locally-filtered table can be empty even though the real result
  // is still loading, so we render a Searching… spinner instead of a false
  // "No orders match". (refreshing = manual refetch OR background fetch with
  // placeholder data; see useOrders.)
  const isSearchTransitionPending = searchQuery.trim() !== debouncedSearchQuery.trim()
  const ordersSearching = refreshing || isSearchTransitionPending
  const matchingSelectionQuery = useMemo(() => {
    const trimmedSearch = debouncedSearchQuery.trim()
    const trimmedSku = skuFilter.trim()
    const isGlobalSearch = trimmedSearch.length > 0
    return {
      ...(isGlobalSearch
        ? // PS-210: same explicit global intent the visible table now sends —
          // selection matching and the table read the SAME backend result set
          // (lifecycle union of awaiting/shipped/cancelled, store scope off).
          { searchScope: 'global' as const }
        : {
          orderStatus: currentStatus,
          storeId: activeStore ?? undefined,
        }),
      dateStart: dateRange.start,
      dateEnd: dateRange.end,
      hideTestOrders: hideTestOrdersInAllAwaiting,
      includeInactiveClients,
      ...(trimmedSearch ? { search: trimmedSearch } : {}),
      ...(trimmedSku ? { sku: trimmedSku } : {}),
      ...(skuSortActive ? { sortBy: 'sku' as const } : {}),
    }
  }, [
    activeStore,
    currentStatus,
    dateRange.end,
    dateRange.start,
    debouncedSearchQuery,
    hideTestOrdersInAllAwaiting,
    includeInactiveClients,
    skuFilter,
    skuSortActive,
  ])
  const selectionScopeKey = useMemo(
    () => JSON.stringify({
      ...matchingSelectionQuery,
      pageSize,
      skuSortActive,
    }),
    [matchingSelectionQuery, pageSize, skuSortActive],
  )
  const lastSelectionScopeKeyRef = useRef(selectionScopeKey)
  const refetchOrdersRef = useRef(refetchOrders)
  useEffect(() => {
    refetchOrdersRef.current = refetchOrders
  }, [refetchOrders])
  const scheduleOrdersRefetch = useCallback((delayMs = 0) => {
    if (transitionalRefetchTimerRef.current !== null) {
      window.clearTimeout(transitionalRefetchTimerRef.current)
    }
    transitionalRefetchTimerRef.current = window.setTimeout(() => {
      transitionalRefetchTimerRef.current = null
      void refetchOrdersRef.current()
    }, delayMs)
  }, [])

  useEffect(() => {
    onResolvedDateRangeChange?.(dateRange)
  }, [dateRange.start, dateRange.end, onResolvedDateRangeChange])

  const { order: activeOrderDetail, isLoading: activeOrderLoading, error: activeOrderError } = useOrderDetail(
    activeOrderId != null ? String(activeOrderId) : '',
  )
  const awaitingRateAccountsEnabled = currentStatus === 'awaiting_shipment' && orders.length > 0
  const ordersSupportDataEnabled =
    activeOrderId != null ||
    selectedOrderIds.length > 0 ||
    rateBrowserOpen ||
    newOrderOpen ||
    queueOpen ||
    sortState.key === 'custcarrier' ||
    awaitingRateAccountsEnabled
  const { locations } = useLocations({ enabled: ordersSupportDataEnabled })
  // PS-075 — also capture the carrier-accounts load error so a FAILED accounts
  // fetch doesn't masquerade as "loading carriers…" forever.
  const { accounts: shippingAccounts, isLoading: accountsLoadingRaw, error: accountsError } = useShippingAccounts({ enabled: ordersSupportDataEnabled })
  const accountsLoading = accountsLoadingRaw && !accountsError
  // Shipped-row DTO phase: useMarkups removed — every row's money display
  // (awaiting AND shipped) comes from the backend DTO money tuple now.
  // PS-189: the account→service catalog is BACKEND-owned. Static per deploy, so
  // cache it for the session. Until it loads, the service picker shows the saved
  // value only — it never falls back to a local table.
  const { data: carrierServiceCatalogResponse } = useQuery({
    queryKey: ['carrier-service-catalog'],
    queryFn: () => api.get<{ catalog: Record<string, Array<{ code: string; label: string }>> }>('/carriers/service-catalog'),
    staleTime: Infinity,
    enabled: ordersSupportDataEnabled,
  })
  const carrierServiceCatalog = carrierServiceCatalogResponse?.catalog ?? {}

  const orderDetailsById = useMemo(() => (
    activeOrderId != null && activeOrderDetail != null
      ? new Map<number, OrderFullDto>([[activeOrderId, activeOrderDetail]])
      : new Map<number, OrderFullDto>()
  ), [activeOrderId, activeOrderDetail])

  // PS-317: the state-bound Best-Rate helpers live in createBestRateHelpers — a factory called each
  // render with the current state, identical to the old inline closures (no behaviour change).
  const {
    getRateCarrierIdsForAccounts,
    getServiceOptionsForAccount,
    buildStrictBestRateRequest,
    getAutoBestRateRequest,
    getCurrentBestRateDimsLabel,
    hasDisplayableBestRateForCurrentRequest,
    getAwaitingBestRateDisplayState,
    getOrderWithAutoBestRate,
  } = createBestRateHelpers({ autoBestRateEntries, orderDetailsById, shippingAccounts, carrierServiceCatalog })

  const resolvedColumnPrefs = useMemo(
    () => resolveColumnPrefs(TABLE_COLUMNS.map((column) => ({ key: column.key, label: column.label, width: column.width })) as TableColumnConfig[], currentStatus, columnPrefs),
    [currentStatus, columnPrefs],
  )

  // Mobile shows the FULL desktop column set (per operator request
  // 2026-05-09: "i want to see fully the columns... where is the
  // others"). The table scrolls horizontally inside .orders-wrap on
  // narrow viewports — same data, same layout, just swipe-able.
  // The previous mobile-trim-to-4-columns approach hid too much info
  // for operators who use phones in the warehouse.
  //
  // Width fallback chain (defensive — was the source of a thead/tbody
  // misalignment bug 2026-05-09):
  //   1. resolvedColumnPrefs.widths[key]   — user's resized width
  //   2. base.width                         — TABLE_COLUMNS default
  //   3. 80                                 — last-resort sane minimum
  // The previous code did `width: resolvedColumnPrefs.widths[key]`
  // with no fallback, so any missing pref key produced
  // `width: undefined`. With table-layout: fixed + a <colgroup>,
  // an undefined col width meant the browser auto-distributed for
  // that column while the <th> still had an explicit width — making
  // header and body misalign.
  const visibleColumns = useMemo(
    () => resolvedColumnPrefs.orderedColumns
      .filter((column) => !resolvedColumnPrefs.hiddenColumns.has(column.key))
      .map((column) => {
        const base = TABLE_COLUMNS.find((candidate) => candidate.key === column.key)!
        const storedWidth = resolvedColumnPrefs.widths[column.key]
        const safeWidth = (typeof storedWidth === 'number' && storedWidth > 0)
          ? storedWidth
          : (base.width || 80)
        const label = column.key === 'bestrate' && currentStatus !== 'awaiting_shipment'
          ? 'Selected Rate'
          : base.label
        return { ...base, label, width: safeWidth }
      }),
    [currentStatus, resolvedColumnPrefs],
  )
  const tableWidth = useMemo(
    () => Math.max(800, visibleColumns.reduce((totalWidth, column) => totalWidth + column.width, 0)),
    [visibleColumns],
  )
  resolvedColumnPrefsRef.current = resolvedColumnPrefs
  columnPrefsRef.current = columnPrefs
  currentStatusRef.current = currentStatus

  // GLOBAL SKU dropdown — was previously derived from the in-memory
  // `orders` array, so it only ever showed SKUs from the ~50 orders on
  // the current page. Now backed by a /orders/distinct-skus call that
  // returns every SKU across the entire orders table (filtered by the
  // currently-visible status + store so the dropdown still feels
  // contextual when no search is active).
  //
  // The fetch fires once per status+store change (and once on mount).
  // Returning to a previous status re-uses the in-flight cache via the
  // useEffect dep change cycle — perfectly fine for this dropdown
  // because it's hidden until the user clicks it.
  const [globalSkus, setGlobalSkus] = useState<string[]>([])
  const [skuOptionsRequested, setSkuOptionsRequested] = useState(false)
  useEffect(() => {
    if (!skuOptionsRequested) return
    let cancelled = false
    void apiClient
      .fetchDistinctSkus({
        // When no specific store is selected, leave clientId/storeId
        // unset so the dropdown shows EVERY SKU. When a store is
        // active, narrow to that store so the list isn't visually
        // overwhelming with SKUs that don't apply.
        status: currentStatus,
        storeId: activeStore ?? undefined,
        dateFrom: dateRange.start,
        dateTo: dateRange.end,
        includeInactiveClients,
      })
      .then((skus) => {
        if (cancelled) return
        setGlobalSkus(skus)
      })
    return () => {
      cancelled = true
    }
  }, [skuOptionsRequested, currentStatus, activeStore, dateRange.start, dateRange.end, includeInactiveClients])

  // Fall back to the in-memory derivation if the global fetch is empty
  // or hasn't returned yet — keeps the dropdown populated on first
  // render instead of going blank for the network round-trip.
  // PS-166/PS-306/PS-258: the four pure filter/sort derivation memos were moved
  // VERBATIM into useOrdersFilterSort (no behavior change; same dep arrays).
  const { orderedFilteredOrders, skuOrderGroups, visibleOrderIds } = useOrdersFilterSort({
    orders,
    orderDetailsById,
    hideTestOrdersInAllAwaiting,
    searchQuery,
    skuFilter,
    skuSortActive,
    preSkuSortSnapshot,
    sortState,
    shippingAccounts,
  })
  // PS-166/PS-306/PS-258 (Hook wave): the selection STATE container (derived
  // selection memos + `updateSelection` + the two selection-only helpers
  // `toggleOrderSelection`/`selectOrderRange`) moved VERBATIM into
  // useOrdersSelection. `selectedOrderIds` is a controlled PROP (no useState to
  // move). The sibling helpers that touch allMatchingSelection/snapshots
  // (clearSelection, toggleSkuGroupSelection, toggleVisibleSelection,
  // selectAllMatchingOrders, hydrateSelectedOrdersForActions) and the isReadOnly
  // gates intentionally STAY in this shell.
  const {
    selectedIdSet,
    visibleSelectedCount,
    allVisibleSelected,
    someVisibleSelected,
    updateSelection,
    toggleOrderSelection,
    selectOrderRange,
  } = useOrdersSelection({
    selectedOrderIds,
    visibleOrderIds,
    onSelectedOrderIdsChange,
    onActiveOrderIdChange,
  })

  const panelOrderId = activeOrderId ?? (selectedOrderIds.length === 1 ? selectedOrderIds[0] : null)
  const panelOrder = orderedFilteredOrders.find((order) => order.orderId === panelOrderId)
    ?? orders.find((order) => order.orderId === panelOrderId)
    ?? null
  const shouldShowDailyStrip = currentStatus === 'awaiting_shipment' || currentStatus === 'shipped'
  // PS-317: daily-stats fetch/refresh/rollover live in useDailyStats; the strip display is built here.
  const { dailyStats, dailyStatsStatus, dailyStatsError, loadDailyStats } = useDailyStats(currentStatus)
  const dailyStripProgress = dailyStats ? buildDailyStripProgress(dailyStats) : null
  const dailyStatsLoadingWithoutData = dailyStatsStatus !== 'error' && !dailyStats
  const dailyStatsErroredWithoutData = dailyStatsStatus === 'error' && !dailyStats
  const dailyStatsRefreshFailedWithData = dailyStatsStatus === 'error' && Boolean(dailyStats)
  // Replace any "PT" / "PST" / "PDT" suffix in the server-formatted
  // labels with "CA" so the daily strip's date range matches the rest
  // of the app's labeling convention (boss directive 2026-05-07).
  const normalizeTzLabel = (s: string) =>
    s.replace(/\b(?:PST|PDT|PT)\b/g, 'CA')
  const dailyStatsFromLabel = normalizeTzLabel(
    dailyStats?.window?.fromLabel || dailyStats?.window?.from || ''
  )
  const dailyStatsToLabel = normalizeTzLabel(
    dailyStats?.window?.toLabel || dailyStats?.window?.to || ''
  )
  const panelDetail = panelOrderId != null ? orderDetailsById.get(panelOrderId) ?? null : null

  // PS-317: recipient-editor state + save live in useRecipientEditor.
  const {
    recipientEditorOpen,
    setRecipientEditorOpen,
    recipientEditorSaving,
    recipientDraft,
    openRecipientEditor,
    updateRecipientDraft,
    saveRecipientOverride,
  } = useRecipientEditor({
    orderId: panelOrder?.orderId ?? null,
    initialShipTo: panelOrder ? getShipTo(panelOrder, panelDetail) : null,
    showToast,
    refetchOrders,
  })
  const activeStoreClientId = useMemo(() => {
    if (activeStore == null) return null
    if (activeStore < 0) return Math.abs(activeStore)
    const store = stores.find((row) => row.storeId === activeStore)
    return typeof store?.clientId === 'number' ? store.clientId : null
  }, [activeStore, stores])
  const inferredQueueClientId = useMemo(() => {
    const selected = orders.find((order) => selectedIdSet.has(order.orderId) && order.clientId != null)
    if (selected?.clientId != null) return selected.clientId
    if (panelOrder?.clientId != null) return panelOrder.clientId
    if (activeStoreClientId != null) return activeStoreClientId
    return orders.find((order) => order.clientId != null)?.clientId ?? null
  }, [activeStoreClientId, orders, panelOrder, selectedIdSet])
  // The queue FETCH is always all-authorized-scope — there is no per-client
  // fetch scope (the Print Queue client dropdown narrows the VIEW client-side
  // via pqClientFilter). Kept as an explicit typed constant, not deleted, so
  // every fetchQueue call site still names the scope argument it passes.
  // (Replaces the vestigial `queueScope` useState that was permanently 'all'.)
  const queueClientId: number | null = null
  const queueClientLabel = useMemo(() => {
    if (inferredQueueClientId == null) return 'Current client'
    const matchingOrder = [
      panelOrder,
      ...orders,
    ].find((order) => order?.clientId === inferredQueueClientId)
    if (matchingOrder?.clientName) return matchingOrder.clientName
    const matchingStore = stores.find((store) => store.clientId === inferredQueueClientId)
    return matchingStore?.storeName || matchingStore?.name || `Client ${inferredQueueClientId}`
  }, [inferredQueueClientId, orders, panelOrder, stores])

  useEffect(() => {
    setPage(1)
  }, [currentStatus, activeStore, dateFilter, customDateFrom, customDateTo, hideTestOrdersInAllAwaiting, debouncedSearchQuery])

  useEffect(() => {
    setPreSkuSortSnapshot(null)
    setSkuSortActive(false)
  }, [currentStatus, activeStore, dateFilter, customDateFrom, customDateTo, skuFilter, debouncedSearchQuery])

  useEffect(() => {
    setSelectedOrderSnapshots((current) => {
      const next = new Map(current)
      const keepIds = new Set(selectedOrderIds)
      for (const order of orders) {
        if (keepIds.has(order.orderId)) next.set(order.orderId, order)
      }
      for (const id of next.keys()) {
        if (!keepIds.has(id)) next.delete(id)
      }
      return next
    })
  }, [orders, selectedOrderIds])

  useEffect(() => {
    if (lastSelectionScopeKeyRef.current === selectionScopeKey) return
    lastSelectionScopeKeyRef.current = selectionScopeKey
    if (selectedOrderIds.length > 0) {
      clearSelection()
    }
  }, [onActiveOrderIdChange, onSelectedOrderIdsChange, selectedOrderIds.length, selectionScopeKey])

  useEffect(() => {
    if (allMatchingSelection && allMatchingSelection.scopeKey !== selectionScopeKey) {
      clearSelection()
      return
    }

    const visibleIds = new Set(orders.map((order) => order.orderId))
    if (activeOrderId != null && !visibleIds.has(activeOrderId) && !selectedIdSet.has(activeOrderId)) {
      onActiveOrderIdChange?.(null)
    }
  }, [
    activeOrderId,
    allMatchingSelection,
    onActiveOrderIdChange,
    onSelectedOrderIdsChange,
    orders,
    selectedIdSet,
    selectionScopeKey,
  ])

  useEffect(() => {
    if (!selectAllCheckboxRef.current) return
    selectAllCheckboxRef.current.indeterminate = someVisibleSelected
  }, [someVisibleSelected])

  useEffect(() => {
    if (packagesLoaded || packages.length > 0) return
    if (panelOrderId == null && !rateBrowserOpen && !newOrderOpen && !queueOpen) return

    let cancelled = false

    setPackagesLoaded(false)
    void apiClient.fetchPackages()
      .then((payload) => {
        if (!cancelled) {
          setPackages(payload)
          setPackagesLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPackages([])
          setPackagesLoaded(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [panelOrderId, packages.length, packagesLoaded, queueOpen, rateBrowserOpen, newOrderOpen])

  useEffect(() => {
    let cancelled = false
    const localPrefs = readLocalColumnPrefs()
    if (localPrefs) {
      columnPrefsRef.current = localPrefs
      setColumnPrefs(localPrefs)
    }

    const cancelScheduled = scheduleNonCriticalOrdersWork(() => {
      void apiClient.fetchColumnPrefs()
        .then((payload) => {
          if (!cancelled) {
            const nextPrefs = payload ?? localPrefs
            if (nextPrefs) writeLocalColumnPrefs(nextPrefs)
            columnPrefsRef.current = nextPrefs
            setColumnPrefs(nextPrefs)
          }
        })
        .catch(() => {
          if (!cancelled) {
            columnPrefsRef.current = localPrefs
            setColumnPrefs(localPrefs)
          }
        })
    }, 4000)

    return () => {
      cancelled = true
      cancelScheduled()
    }
  }, [])


  useEffect(() => {
    if (refreshVersion === 0) return
    if (lastHandledRefreshVersionRef.current === refreshVersion) return
    lastHandledRefreshVersionRef.current = refreshVersion
    void refetchOrdersRef.current()
    if (panelOrderId != null) {
      void queryClient.invalidateQueries({ queryKey: ['v2-hooks:order-detail', panelOrderId] })
    }
  }, [refreshVersion, panelOrderId, queryClient])

  // Sidebar nav resets — Home bumps `filterResetVersion` whenever the
  // user clicks a sidebar entry. We clear all OrdersView-local filters
  // (sku + custom date inputs) so the new view starts with a clean
  // slate. Search + dateFilter live in Home and are reset there
  // directly. Skip on initial mount (filterResetVersion=0) so a
  // bookmarked /orders/awaiting_shipment URL doesn't lose pre-filled
  // filter state on first render.
  useEffect(() => {
    if (filterResetVersion === 0) return
    setSkuFilter('')
    setCustomDateFrom('')
    setCustomDateTo('')
    setPage(1)
  }, [filterResetVersion])

  useEffect(() => {
    if (queueToggleRequestId === 0) return
    setQueueOpen((open) => !open)
  }, [queueToggleRequestId])

  useEffect(() => {
    if (labelsActionRequestId === 0) return
    void handleTopbarLabels()
  }, [labelsActionRequestId])

  // PS-317 (Phase 3): the column-resize mousemove/mouseup drag-resize effect now lives in useColumnResize.

  useEffect(() => {
    onQueueStateChange?.({
      count: queueEntries.filter((entry) => entry.status === 'queued').length,
      isOpen: queueOpen,
    })
  }, [queueEntries, queueOpen, onQueueStateChange])

  useEffect(() => {
    let cancelled = false

    const hydrateQueue = async () => {
      if (queueOpen) setQueueLoading(true)
      try {
        const payload = await apiClient.fetchQueue(queueClientId, queueHistoryVisible)
        if (!cancelled) {
          setQueueEntries(getQueuePayloadEntries(payload))
          setQueueEntriesClientId(queueClientId)
        }
      } catch (error) {
        if (!cancelled && queueOpen) {
          toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load print queue', 'error')
        }
      } finally {
        if (!cancelled && queueOpen) setQueueLoading(false)
      }
    }

    void hydrateQueue()
    if (!queueOpen) {
      return () => {
        cancelled = true
      }
    }

    const interval = window.setInterval(() => {
      void hydrateQueue()
    }, 30000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [queueOpen, queueClientId, queueHistoryVisible, toastContext])

  useEffect(() => {
    if (!queueOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (detailDrawerFromQueue && detailDrawerOrderId != null) return
      const panel = document.getElementById('print-queue-panel')
      const trigger = document.getElementById('pq-toggle-btn')
      if (panel && panel.contains(target)) return
      if (trigger && trigger.contains(target)) return
      setQueueOpen(false)
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQueueOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [queueOpen, detailDrawerFromQueue, detailDrawerOrderId])

  useEffect(() => {
    if (!panelOrder) {
      panelFormInitKeyRef.current = null
      shipmentLastSavedKeyRef.current = null
      bestRateRefreshSeqRef.current += 1
      setPanelRateLoading(false)
      return
    }

    const initKey = `${panelOrder.orderId}:${panelDetail ? 'detail' : 'summary'}`
    const dimensions = getDimensions(panelOrder, panelDetail)
    const locationId = getPanelWarehouseId(panelOrder, panelDetail) ?? locations.find((location) => location.isDefault)?.locationId ?? locations[0]?.locationId ?? null
    const matchedPackageId = getMatchedPackageIdByDimensions(dimensions, packages)
    const selectedAccountValue = getInitialPanelShipAccountId(panelOrder, panelDetail)
    const currentWeight = getOrderWeightOz(panelOrder, panelDetail)
    const insurance = getPanelInsurance(panelOrder, panelDetail)
    const panelIsTestOrder = isTestOrder(panelOrder, panelDetail)

    if (panelFormInitKeyRef.current === initKey) {
      setPanelForm((current) => {
        if (current.packageId) return current
        const currentDims = {
          length: Number.parseFloat(current.length) || 0,
          width: Number.parseFloat(current.width) || 0,
          height: Number.parseFloat(current.height) || 0,
        }
        const nextPackageId = getPanelPackageId(panelOrder, panelDetail, packages)
          || getComboDefaultPackageId(panelDetail, packages)
          || getMatchedPackageIdByDimensions(hasCompleteDims(currentDims) ? currentDims : dimensions, packages)
        if (!nextPackageId) return current
        const next = { ...current, packageId: nextPackageId }
        shipmentLastSavedKeyRef.current = getShipmentDetailsKey(panelOrder.orderId, next)
        return next
      })
      return
    }

    panelFormInitKeyRef.current = initKey
    bestRateRefreshSeqRef.current += 1
    const initialServiceCode = panelIsTestOrder ? TEST_SERVICE_CODE : getInitialPanelServiceCode(panelOrder, panelDetail)
    // PS-123: non-authoritative UX seed only. The backend/shared resolver owns the
    // effective HUGRAB provider/value used for quote fingerprints, proof, and labels.
    // This keeps the panel display aligned without letting the frontend decide rates.
    // PS-072: default the panel Insurance to the HUGRAB ground policy (Parcel Guard
    // $100 for UPS Ground and USPS Ground/Ground Advantage) when the
    // operator has not explicitly chosen insurance — so the UI visibly shows what
    // the backend will charge. resolveEffectiveInsurance never touches Ground
    // Saver/SurePost (PS-057) or non-HUGRAB orders.
    const seededInsurance =
      insurance.type && insurance.type !== 'none'
        ? { type: insurance.type, value: insurance.value }
        : (() => {
          const effective = resolveEffectiveInsurance(
            { clientId: panelOrder.clientId, storeId: panelOrder.storeId },
            {
              carrierCode: inferCarrierFromServiceCode(initialServiceCode),
              serviceCode: initialServiceCode,
              serviceName: initialServiceCode,
            },
            { insuranceProvider: insurance.type, insuredValue: insurance.value },
          )
          return { type: effective.insuranceProvider, value: effective.insuredValue }
        })()
    const initialPanelForm: PanelFormState = {
      locationId: locationId != null ? String(locationId) : '',
      shipAccountId: panelIsTestOrder ? TEST_CARRIER_CODE : selectedAccountValue != null ? String(selectedAccountValue) : '',
      serviceCode: initialServiceCode,
      weightLb: currentWeight ? String(Math.floor(currentWeight / 16)) : '',
      weightOz: currentWeight ? String(Math.round(currentWeight % 16)) : '',
      length: dimensions?.length ? String(dimensions.length) : '',
      width: dimensions?.width ? String(dimensions.width) : '',
      height: dimensions?.height ? String(dimensions.height) : '',
      packageId: getPanelPackageId(panelOrder, panelDetail, packages) || getComboDefaultPackageId(panelDetail, packages) || matchedPackageId,
      confirmation: getPanelConfirmation(panelOrder, panelDetail),
      insurance: seededInsurance.type,
      insuranceValue: seededInsurance.value != null ? String(seededInsurance.value) : '',
    }
    shipmentLastSavedKeyRef.current = getShipmentDetailsKey(panelOrder.orderId, initialPanelForm)
    setPanelForm(initialPanelForm)
    setPanelRatePreview([])

    const activeItems = getActiveItems(panelOrder, panelDetail).filter((item) => item.sku)
    const uniqueSkus = [...new Set(activeItems.map((item) => item.sku).filter(Boolean))]
    if (!uniqueSkus.length) return

    // PS-177 (Phase 5) / PS-178 final part: dims/weight/package defaults are
    // BACKEND-owned — one server-side resolution on the detail payload
    // (dimsDefaults). The per-SKU FE fetch loop + client-side stacking
    // derivation are DELETED; a payload without the block simply leaves the
    // fields for the operator (no FE-derived dims policy, ever).
    const backendDimsDefaults = toRecord((panelDetail as Record<string, unknown> | null)?.dimsDefaults)
    const seedFromBackendDefaults = () => {
      if (!backendDimsDefaults) return false
      const dimsRecord = toRecord(backendDimsDefaults.dims)
      const derivedDims = dimsRecord
        ? {
          length: toNumberValue(dimsRecord.length) ?? 0,
          width: toNumberValue(dimsRecord.width) ?? 0,
          height: toNumberValue(dimsRecord.height) ?? 0,
        }
        : null
      const backendWeightOz = toNumberValue(backendDimsDefaults.weightOz)
      const backendPackageCode = toStringValue(backendDimsDefaults.defaultPackageCode)
      const backendPackageId = toNumberValue(backendDimsDefaults.packageId)
      const payload = backendWeightOz != null || backendPackageCode || backendPackageId != null
        ? {
          weightOz: backendWeightOz ?? 0,
          defaultPackageCode: backendPackageCode ?? null,
          packageId: backendPackageId ?? null,
        }
        : null
      const completeDims = derivedDims && derivedDims.length > 0 && derivedDims.width > 0 && derivedDims.height > 0
        ? derivedDims
        : null
      if (!payload && !completeDims) return false
      applyProductDefaultSeeds(payload, completeDims)
      return true
    }
    seedFromBackendDefaults()

    function applyProductDefaultSeeds(
      payload: Record<string, unknown> | null,
      derivedDims: { length: number; width: number; height: number } | null,
    ) {
        setPanelForm((current) => {
          const nextWeightLb = current.weightLb || current.weightOz
            ? current.weightLb
            : payload && (payload.weightOz as number) > 0
              ? String(Math.floor((payload.weightOz as number) / 16))
              : ''
          const nextWeightOz = current.weightLb || current.weightOz
            ? current.weightOz
            : payload && (payload.weightOz as number) > 0
              ? String(Math.round((payload.weightOz as number) % 16))
              : ''
          const nextLength = current.length || !derivedDims?.length ? current.length : String(derivedDims.length)
          const nextWidth = current.width || !derivedDims?.width ? current.width : String(derivedDims.width)
          const nextHeight = current.height || !derivedDims?.height ? current.height : String(derivedDims.height)
          const nextPackageId = current.packageId
            || (payload ? getProductDefaultPackageId(payload, packages) : '')
            || getMatchedPackageIdByDimensions(
              nextLength && nextWidth && nextHeight
                ? {
                  length: Number.parseFloat(nextLength) || 0,
                  width: Number.parseFloat(nextWidth) || 0,
                  height: Number.parseFloat(nextHeight) || 0,
                }
                : null,
              packages,
            )

          return {
            ...current,
            weightLb: nextWeightLb,
            weightOz: nextWeightOz,
            length: nextLength,
            width: nextWidth,
            height: nextHeight,
            packageId: nextPackageId,
          }
        })
    }
  }, [panelOrderId, panelOrder, panelDetail, locations, packages])

  useEffect(() => {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment' || isTestOrder(panelOrder, panelDetail)) {
      panelRateSelectionSyncKeyRef.current = null
      return
    }

    const displayOrder = getOrderWithAutoBestRate(panelOrder)
    const providerId = getBestRateShippingProviderId(displayOrder)
    const serviceCode = getBestRateServiceCode(displayOrder)
    const fingerprint = rateProofFingerprint(toRecord(displayOrder.bestRate))
    if (providerId == null && !serviceCode) return

    const syncKey = `${displayOrder.orderId}:${providerId ?? ''}:${serviceCode ?? ''}:${fingerprint ?? ''}`
    if (panelRateSelectionSyncKeyRef.current === syncKey) return
    panelRateSelectionSyncKeyRef.current = syncKey

    setPanelForm((current) => {
      const nextShipAccountId = providerId != null ? String(providerId) : current.shipAccountId
      const nextServiceCode = serviceCode || current.serviceCode
      if (current.shipAccountId === nextShipAccountId && current.serviceCode === nextServiceCode) {
        return current
      }
      const next = {
        ...current,
        shipAccountId: nextShipAccountId,
        serviceCode: nextServiceCode,
      }
      shipmentLastSavedKeyRef.current = getShipmentDetailsKey(displayOrder.orderId, next)
      return next
    })
  }, [panelOrderId, panelOrder, panelDetail, autoBestRateEntries])

  useEffect(() => {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment' || !packagesLoaded) return
    // PS-193: GATED on an actual operator edit. Pre-PS-193 this fired on
    // panel OPEN whenever the seeded dims were complete — silently
    // auto-matching/auto-CREATING a package row, persisting the order's
    // selected package, and (via saveSku) minting per-unit SKU weight/dims
    // PRODUCT DEFAULTS that seeded FUTURE orders' rate inputs, all with zero
    // operator action. Suggestions stay visible in the form; nothing persists
    // until the operator edits.
    if (!dimsUserEditedRef.current) return

    const dims = getPanelDims()
    if (!hasCompleteDims(dims)) return

    const key = `${panelOrder.orderId}:${getDimsKey(dims)}`
    if (autoPackageDimsKeyRef.current === key) return

    const timeout = window.setTimeout(() => {
      if (autoPackageDimsKeyRef.current === key) return
      autoPackageDimsKeyRef.current = key
      // PS-193: saveSku:false — product-default minting (incl. the per-unit
      // weight ÷ qty math) is reserved for the EXPLICIT Save-SKU-defaults
      // action and the post-label-purchase followup, never a dims-edit
      // byproduct.
      void ensurePanelPackageForDims({ saveSku: false, silent: true })
        .catch(() => {
          autoPackageDimsKeyRef.current = null
        })
    }, 450)

    return () => window.clearTimeout(timeout)
  }, [panelOrderId, panelOrder?.orderStatus, panelForm.length, panelForm.width, panelForm.height, packages, packagesLoaded])

  // Reset the "user has edited dims" flag whenever the active order changes.
  // Without this, switching from order A (where the user typed) to order B
  // would leave the flag set and immediately auto-refresh B's rate just by
  // clicking — defeating the whole guard.
  useEffect(() => {
    dimsUserEditedRef.current = false
  }, [panelOrderId])

  // Auto-refresh the panel's best rate whenever weight or any dimension
  // changes. Debounced so a user typing "1 → 12 → 125" doesn't fire three
  // separate /rates calls. refreshPanelBestRate already toggles
  // panelRateLoading and uses bestRateRefreshSeqRef to ignore stale results
  // when the inputs change again before a fetch completes.
  //
  // Only fire when the user has *manually* edited weight or dims. Clicking an
  // order seeds the form values in a separate render cycle, which would also
  // trip this effect — we ignore those programmatic fills via the user-edit
  // flag set in the input onChange handlers.
  useEffect(() => {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment') return
    if (!dimsUserEditedRef.current) return
    const dims = getPanelDims()
    const weightOz = getPanelWeightOz()
    if (!hasCompleteDims(dims) || weightOz <= 0) return

    const handle = window.setTimeout(() => {
      void refreshPanelBestRate({ order: panelOrder, dims, weightOz, silent: true })
    }, 700)

    return () => window.clearTimeout(handle)
    // panelOrder identity intentionally re-checked via id; eslint disable for
    // the inline calls (refreshPanelBestRate / getPanelDims / getPanelWeightOz
    // are stable closures that read latest state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    panelOrderId,
    panelOrder?.orderStatus,
    panelForm.weightLb,
    panelForm.weightOz,
    panelForm.length,
    panelForm.width,
    panelForm.height,
  ])

  useEffect(() => {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment') return
    // PS-193: the debounced auto-persist is GATED on an actual operator edit
    // (the same dirty flag the rate-refresh effect uses). Programmatic form
    // fills — panel-open seeding, backend dims suggestions, the auto-package
    // match above — must never reach the DB on their own. Rating and label
    // purchase read the LIVE form values, so unsaved suggestions still price
    // and buy exactly as shown.
    if (!dimsUserEditedRef.current) return

    const currentKey = getShipmentDetailsKey(panelOrder.orderId, panelForm)
    if (!currentKey || currentKey === shipmentLastSavedKeyRef.current) return

    const dims = getPanelDims()
    const weightOz = getPanelWeightOz()
    const hasWeightToSave = (panelForm.weightLb.trim() !== '' || panelForm.weightOz.trim() !== '') && weightOz > 0
    const hasSomethingToSave = hasWeightToSave || hasCompleteDims(dims) || Boolean(panelForm.packageId)
    if (!hasSomethingToSave) return

    if (shipmentAutoSaveTimerRef.current != null) {
      window.clearTimeout(shipmentAutoSaveTimerRef.current)
    }

    shipmentAutoSaveTimerRef.current = window.setTimeout(() => {
      shipmentAutoSaveTimerRef.current = null
      void persistShipmentDetails({
        silent: true,
        refreshBestRate: true,
        skipIfUnchanged: true,
      })
    }, 750)

    return () => {
      if (shipmentAutoSaveTimerRef.current != null) {
        window.clearTimeout(shipmentAutoSaveTimerRef.current)
        shipmentAutoSaveTimerRef.current = null
      }
    }
  }, [
    panelOrderId,
    panelOrder?.orderStatus,
    panelForm.weightLb,
    panelForm.weightOz,
    panelForm.length,
    panelForm.width,
    panelForm.height,
    panelForm.packageId,
    panelDetail,
    packages,
  ])

  // Escape only: the rate-browser close gate + clear-selection live here with
  // their owners. The Arrow/Enter/Ctrl-C ROW-NAV branches (and the kbRowId
  // state they drive) moved DOWN into OrdersTable (2026-07-08) so hover /
  // keyboard row focus re-renders the table, not this whole shell.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return

      if (event.key === 'Escape') {
        if (rateBrowserOpen) {
          // PS-286: the Escape-key close is the 4th close path — route it through the
          // gate too so Esc during an in-flight persist can't re-open the stale-row race.
          void closeRateBrowserAfterPersist()
          return
        }
        clearSelection()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [rateBrowserOpen])


  // PS-166/PS-306/PS-258 (Hook wave): updateSelection now comes from
  // useOrdersSelection (destructured above).
  const openOrderDetails = (orderId: number) => {
    onActiveOrderIdChange?.(orderId)
  }

  const recipientInput = (key: keyof RecipientDraft, label: string, autoComplete?: string) => (
    <label className="block">
      <span className="block text-[10px] font-bold uppercase tracking-[0.08em] text-ink-4 mb-1">{label}</span>
      <input
        value={recipientDraft[key]}
        autoComplete={autoComplete}
        disabled={recipientEditorSaving}
        onChange={(event) => updateRecipientDraft(key, event.target.value)}
        className="w-full h-9 rounded-md border border-line bg-surface px-2.5 text-[12.5px] text-ink outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand disabled:opacity-60"
      />
    </label>
  )

  const openDetailDrawer = (orderId: number | null, fromQueue = false) => {
    setDetailDrawerFromQueue(fromQueue)
    setDetailDrawerOrderId(orderId)
  }

  const closeDetailDrawer = () => {
    if (detailDrawerFromQueue) setQueueOpen(true)
    setDetailDrawerOrderId(null)
    setDetailDrawerFromQueue(false)
  }

  // PS-166/PS-306/PS-258 (Hook wave): toggleOrderSelection + selectOrderRange now
  // come from useOrdersSelection (destructured above) — they touch ONLY selection.
  const toggleSkuGroupSelection = (orderIds: number[], checked?: boolean) => {
    setAllMatchingSelection(null)
    const orderIdSet = new Set(orderIds)
    const allSelected = orderIds.length > 0 && orderIds.every((orderId) => selectedIdSet.has(orderId))
    const shouldSelect = checked ?? !allSelected
    if (shouldSelect) {
      updateSelection([...selectedOrderIds, ...orderIds])
      return
    }

    updateSelection(selectedOrderIds.filter((id) => !orderIdSet.has(id)))
  }

  const toggleVisibleSelection = (checked?: boolean) => {
    setAllMatchingSelection(null)
    const visibleOrderIdSet = new Set(visibleOrderIds)
    const shouldSelect = checked ?? !allVisibleSelected
    if (shouldSelect) {
      updateSelection([...selectedOrderIds, ...visibleOrderIds])
      return
    }

    updateSelection(selectedOrderIds.filter((id) => !visibleOrderIdSet.has(id)))
  }

  const selectAllMatchingOrders = async () => {
    if (isReadOnly || selectingAllMatching) return
    setSelectingAllMatching(true)
    try {
      const result = await apiClient.fetchMatchingOrderIds({
        ...matchingSelectionQuery,
        selectionLimit: 5000,
      })
      if (result.ids.length === 0) {
        setAllMatchingSelection(null)
        updateSelection([])
        showToast('No matching orders to select', 'info')
        return
      }
      setAllMatchingSelection({
        active: true,
        scopeKey: selectionScopeKey,
        ids: result.ids,
        total: result.total,
        truncated: result.truncated,
        selectionLimit: result.selectionLimit,
      })
      updateSelection(result.ids)
      showToast(
        result.truncated
          ? `Selected first ${result.ids.length.toLocaleString()} matching orders (limit ${result.selectionLimit.toLocaleString()})`
          : `Selected ${result.ids.length.toLocaleString()} matching orders`,
        result.truncated ? 'error' : 'success',
      )
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to select matching orders', 'error')
    } finally {
      setSelectingAllMatching(false)
    }
  }

  const hydrateSelectedOrdersForActions = async (): Promise<OrderSummaryDto[]> => {
    if (selectedOrderIds.length === 0) return []
    const snapshotById = new Map(selectedOrderSnapshots)
    for (const order of orders) {
      if (selectedIdSet.has(order.orderId)) snapshotById.set(order.orderId, order)
    }

    const missingIds = selectedOrderIds.filter((orderId) => !snapshotById.has(orderId))
    if (missingIds.length > 0) {
      const matchingOrders = await apiClient.fetchMatchingOrdersForSelection(matchingSelectionQuery)
      for (const order of matchingOrders) {
        if (selectedIdSet.has(order.orderId)) snapshotById.set(order.orderId, order)
      }
    }

    const hydrated = selectedOrderIds
      .map((orderId) => snapshotById.get(orderId))
      .filter((order): order is OrderSummaryDto => Boolean(order))

    if (hydrated.length !== selectedOrderIds.length) {
      throw new Error(`Only ${hydrated.length}/${selectedOrderIds.length} selected orders could be loaded. Clear selection and try again.`)
    }

    setSelectedOrderSnapshots((current) => {
      const next = new Map(current)
      for (const order of hydrated) next.set(order.orderId, order)
      return next
    })
    return hydrated
  }

  // Hoisted `function` (not a const arrow) so the two scope-reset effects ABOVE
  // this textual position can call it directly — effects run after the whole
  // component body, so every setter it closes over is initialized by then.
  // (Those effects previously inlined this exact body because the const wasn't
  // hoisted.)
  function clearSelection() {
    setAllMatchingSelection(null)
    setSelectedOrderSnapshots(new Map())
    onSelectedOrderIdsChange?.([])
    onActiveOrderIdChange?.(null)
  }

  // PS-312/PS-317 (S4): the "Combine shipments" action (POST /orders/bundles + the backend's toast
  // verdict + the post-combine refresh) lives in the bundle hook; OrdersView just wires its toast +
  // selection/refetch. handleCombineShipments below is the thin no-arg adapter the batch panel calls.
  const { combineBusy, combineShipments } = useCombineShipments({
    showToast,
    onCombined: async () => {
      clearSelection()
      await refetchOrders()
    },
  })

  const closeSinglePanel = () => {
    const activeIsOnlySelection =
      activeOrderId != null &&
      selectedOrderIds.length === 1 &&
      selectedOrderIds[0] === activeOrderId

    if (activeOrderId != null && !activeIsOnlySelection) {
      onActiveOrderIdChange?.(null)
      return
    }

    clearSelection()
  }

  function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
    toastContext?.addToast(message, type)
  }

  type QueueSendUiResult = {
    queued: number
    skipped: number
    failed: number
    queuedItems: Parameters<typeof formatQueuedOrdersToast>[1]
    skippedErrors: string[]
    failedErrors: string[]
  }

  function queueSendToastType(result: QueueSendUiResult): 'success' | 'error' | 'info' {
    if (result.failed > 0) return 'error'
    if (result.skipped > 0) return 'info'
    return 'success'
  }

  function formatQueueSendResultToast(result: QueueSendUiResult): string {
    return formatQueuedOrdersToast(result.queued, result.queuedItems, {
      skippedCount: result.skipped,
      failedCount: result.failed,
      skippedReasons: result.skippedErrors,
      failedReasons: result.failedErrors,
    })
  }

  // PS-178 (Phase 6, part 4): the toolbar JSX moved VERBATIM to the render-only
  // ./OrdersSelectionToolbar component; selection state + every batch handler
  // stay here and flow down as props. The thin wrapper keeps this call site.
  const renderSelectionToolbar = () => (
    <OrdersSelectionToolbar
      selectedOrderIds={selectedOrderIds}
      allMatchingSelection={allMatchingSelection}
      selectionScopeKey={selectionScopeKey}
      currentStatus={currentStatus}
      isMobileViewport={isMobileViewport}
      batchBusy={batchBusy}
      extShipBusy={extShipBusy}
      batchExtShipMenuOpen={batchExtShipMenuOpen}
      setBatchExtShipMenuOpen={setBatchExtShipMenuOpen}
      batchTestMode={batchTestMode}
      setBatchTestMode={setBatchTestMode}
      handleBatchAction={handleBatchAction}
      handleBatchMarkAsShipped={handleBatchMarkAsShipped}
      queueExistingLabels={queueExistingLabels}
      clearSelection={clearSelection}
    />
  )

  function getPanelWeightOz() {
    return getPanelWeightOzFromForm(panelForm)
  }

  function buildPanelShippingOptionsPayload(form: PanelFormState = panelForm) {
    const insurance = normalizeInsuranceForRates(form.insurance, form.insuranceValue)
    return {
      confirmation: normalizeConfirmationForRates(form.confirmation),
      insuranceProvider: insurance.insuranceProvider,
      insuredValue: insurance.insuredValue,
    }
  }

  function buildOrderShippingOptionsPayload(order: OrderSummaryDto) {
    const rate = toRecord(order.selectedRate) ?? toRecord(order.bestRate) ?? toRecord(getShippingModel(order)?.bestRate)
    const insurance = normalizeInsuranceForRates(
      toStringValue(rate?.insuranceProvider) ?? toStringValue(getShippingModel(order)?.insuranceProvider) ?? 'none',
      toNumberValue(rate?.insuredValue) ?? toNumberValue(getShippingModel(order)?.insuredValue) ?? null,
    )
    return {
      confirmation: normalizeConfirmationForRates(
        toStringValue(rate?.confirmation) ?? toStringValue(getShippingModel(order)?.confirmation) ?? 'none',
      ),
      insuranceProvider: insurance.insuranceProvider,
      insuredValue: insurance.insuredValue,
    }
  }

  function getPanelDims() {
    return getPanelDimsFromForm(panelForm)
  }

  function getPanelSkuDefaultDims(packageId: string | null) {
    const panelDims = getPanelDims()
    if (hasCompleteDims(panelDims)) return panelDims

    const selectedPackageId = packageId || panelForm.packageId
    const selectedPackage = selectedPackageId
      ? packages.find((candidate) => getPackageIdentifier(candidate) === selectedPackageId)
      : null
    return getPackageDims(selectedPackage) ?? panelDims
  }

  // PS-207 (B): dims ⇄ package lockstep, FE side. When the operator types
  // dims that EXACTLY match a known package, reflect that package in the
  // dropdown (the backend save-dims path persists the same auto-selection).
  // Custom dims leave the selection untouched — billing flags cross-time
  // disagreement as a review line; the panel never guesses.
  function lockstepPanelDims<T extends { length: string; width: string; height: string; packageId: string }>(next: T): T {
    const l = Number(next.length)
    const w = Number(next.width)
    const h = Number(next.height)
    if (!(l > 0 && w > 0 && h > 0)) return next
    const match = packages.find((pkg) => {
      const d = getPackageDims(pkg)
      return d && Number(d.length) === l && Number(d.width) === w && Number(d.height) === h
    })
    const id = match ? getPackageIdentifier(match) : ''
    return id && id !== next.packageId ? { ...next, packageId: id } : next
  }

  // PS-178 final part: deriveShipmentDimsFromProductDefaults DELETED — the
  // stacking derivation is backend-owned (order-dims-defaults-policy.ts) and
  // arrives on the detail payload as dimsDefaults.

  function assertSavedProductDefaults(
    product: unknown,
    expected: {
      sku: string
      weightOz: number
      length: number
      width: number
      height: number
      defaultPackageCode: string | null
    },
  ) {
    const row = toRecord(product)
    if (!row || toStringValue(row.sku) !== expected.sku) {
      throw new Error('SKU defaults were not saved')
    }

    const readNumber = (value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim()) {
        const parsed = Number.parseFloat(value)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }
    const matches = (field: 'weightOz' | 'length' | 'width' | 'height', expectedValue: number) => {
      if (expectedValue <= 0) return true
      const savedValue = readNumber(row[field])
      return savedValue != null && Math.abs(savedValue - expectedValue) <= 0.01
    }

    if (
      !matches('weightOz', expected.weightOz)
      || !matches('length', expected.length)
      || !matches('width', expected.width)
      || !matches('height', expected.height)
    ) {
      throw new Error('SKU defaults did not match the saved weight and dimensions')
    }

    if (expected.defaultPackageCode) {
      const savedPackageCode = row.defaultPackageCode == null ? null : String(row.defaultPackageCode)
      if (savedPackageCode !== expected.defaultPackageCode) {
        throw new Error('SKU default package was not saved')
      }
    }
  }

  function normalizePanelPackage(pkg: PackageDto | null | undefined) {
    if (!pkg) return null
    const packageId = getPackageIdentifier(pkg)
    return packageId ? { ...pkg, packageId: Number.parseInt(packageId, 10) } : pkg
  }

  function mergePackageIntoState(pkg: PackageDto | null | undefined) {
    const normalized = normalizePanelPackage(pkg)
    const packageId = getPackageIdentifier(normalized)
    if (!normalized || !packageId) return

    setPackages((current) => {
      const index = current.findIndex((candidate) => getPackageIdentifier(candidate) === packageId)
      if (index >= 0) {
        const next = [...current]
        next[index] = { ...current[index], ...normalized }
        return next
      }
      return [...current, normalized]
    })
  }

  function getSingleSkuDefaultTarget(order: OrderSummaryDto, detail: OrderFullDto | null) {
    const items = getActiveItems(order, detail).filter((item) => item.sku)
    const uniqueSkus = [...new Set(items.map((item) => item.sku).filter(Boolean))]
    if (uniqueSkus.length !== 1) return null

    const sku = uniqueSkus[0]!
    const matchingItems = items.filter((item) => item.sku === sku)
    return {
      sku,
      name: matchingItems[0]?.name ?? null,
      qty: matchingItems.reduce((sum, item) => sum + item.quantity, 0) || 1,
    }
  }

  // PS-121: after an EXPLICIT "Save weights & dims as SKU defaults", the backend invalidated +
  // queued a targeted recalc for the same SKU+qty group's stale sibling rates and returned their
  // ids. Surface a clear success/refreshing toast and re-poll /orders a few times so those
  // siblings flip from stale → "refreshing" (PS-120 pending/rating) → final Best Rate. The PS-120
  // watchdog bounds the spinner, so a slow recalc never becomes an indefinite spinner.
  function announceAndRepollGroupRecalc(result: any, baseMessage: string) {
    const applied = Number(result?.appliedMutableOrderCount ?? 0)
    const refreshing = Array.isArray(result?.affectedOrderIds) ? result.affectedOrderIds.length : 0
    showToast(
      refreshing > 0
        ? `${baseMessage} · ${applied} order${applied === 1 ? '' : 's'} · refreshing ${refreshing} rate${refreshing === 1 ? '' : 's'}…`
        : `${baseMessage} · ${applied} order${applied === 1 ? '' : 's'} updated`,
      'success',
    )
    void refetchOrdersRef.current?.()
    if (refreshing > 0) {
      let ticks = 0
      const tick = () => {
        ticks += 1
        void refetchOrdersRef.current?.()
        if (ticks < 8) window.setTimeout(tick, 4000) // ~32s of bounded re-polling
      }
      window.setTimeout(tick, 4000)
    }
  }

  async function savePanelComboDefaults(
    packageId: string | null,
    options: {
      silent?: boolean
      order?: OrderSummaryDto | null
      detail?: OrderFullDto | null
      weightOz?: number
      dims?: ShipmentDims | null
      // PS-121: only the explicit operator save sets this → backend group-recalc.
      recalcGroup?: boolean
    } = {},
  ) {
    const sourceOrder = options.order ?? panelOrder
    if (!sourceOrder) return false

    const sourceDetail = options.detail ?? (
      sourceOrder.orderId === panelOrder?.orderId
        ? panelDetail
        : orderDetailsById.get(sourceOrder.orderId) ?? null
    )
    const hasAnySku = getActiveItems(sourceOrder, sourceDetail).some((item) => item.sku)
    if (!hasAnySku) {
      if (!options.silent) showToast('No products found on this order', 'error')
      return false
    }

    const dims = hasCompleteDims(options.dims) ? options.dims! : getPanelSkuDefaultDims(packageId)
    const weightOz = options.weightOz ?? getPanelWeightOz()
    if (!packageId || !hasCompleteDims(dims)) {
      if (!options.silent) {
        showToast('Package/dims are incomplete for this SKU combination. Select a package or enter complete L x W x H first.', 'error')
      }
      return false
    }

    const result = await apiClient.saveComboPackageDefault(sourceOrder.orderId, {
      packageId,
      length: dims.length,
      width: dims.width,
      height: dims.height,
      weightOz: weightOz > 0 ? weightOz : null,
      ...(options.recalcGroup ? { recalcGroup: true } : {}),
    })
    if (!result?.saved) {
      throw new Error(result?.reason || 'Combo package default was not saved')
    }

    if (sourceOrder.orderId === panelOrder?.orderId) {
      await apiClient.setOrderSelectedPackageId(sourceOrder.orderId, Number.parseInt(packageId, 10))
      const payload: Record<string, number> = {
        length: dims.length,
        width: dims.width,
        height: dims.height,
      }
      if (weightOz > 0) payload.weightOz = weightOz
      await apiClient.saveOrderDims(sourceOrder.orderId, payload)
      setPanelForm((current) => (
        current.packageId === packageId
          ? current
          : {
            ...current,
            packageId,
            length: String(dims.length),
            width: String(dims.width),
            height: String(dims.height),
          }
      ))
      if (weightOz > 0) {
        await refreshPanelBestRate({ order: sourceOrder, dims, weightOz, silent: true })
      }
      await refetchOrders()
    }

    if (options.recalcGroup) {
      announceAndRepollGroupRecalc(result, 'Saved package defaults for this SKU combination')
    } else if (!options.silent) {
      showToast('Saved package defaults for this SKU combination', 'success')
    }
    return true
  }

  async function savePanelSkuDefaults(
    packageId: string | null,
    options: {
      silent?: boolean
      order?: OrderSummaryDto | null
      detail?: OrderFullDto | null
      weightOz?: number
      dims?: ShipmentDims | null
      // PS-121: only the explicit operator save sets this → backend group-recalc.
      recalcGroup?: boolean
    } = {},
  ) {
    const sourceOrder = options.order ?? panelOrder
    if (!sourceOrder) return null

    const sourceDetail = options.detail ?? (
      sourceOrder.orderId === panelOrder?.orderId
        ? panelDetail
        : orderDetailsById.get(sourceOrder.orderId) ?? null
    )
    const target = getSingleSkuDefaultTarget(sourceOrder, sourceDetail)
    if (!target) {
      // PS-037: Multi-SKU orders default by the EXACT client + SKU+qty
      // combination, NOT per individual SKU. Save the chosen package as the
      // combo default (the backend derives the combo key from this order's
      // items). We deliberately do NOT stamp per-SKU inventory package defaults
      // here — that pollutes single-SKU defaults for mixed-SKU clients (Hugrab:
      // e.g. "Booster x1 + Leeds x1" must not change the box for a lone Booster
      // order). Only persisted on an explicit operator save (not the silent
      // auto-detect debouncer) so a dims-matched guess never becomes a default.
      if (options.silent) return null
      await savePanelComboDefaults(packageId, options)
      return null
    }

    const weightOz = options.weightOz ?? getPanelWeightOz()
    const dims = hasCompleteDims(options.dims) ? options.dims! : getPanelSkuDefaultDims(packageId)
    if (!weightOz && !hasCompleteDims(dims)) {
      if (!options.silent) showToast('Enter weight or complete dims first', 'error')
      return null
    }

    const clientId = typeof sourceOrder.clientId === 'number' && sourceOrder.clientId > 0
      ? sourceOrder.clientId
      : null
    const skuWeightOz = target.qty > 1 && weightOz ? Number((weightOz / target.qty).toFixed(2)) : weightOz
    const packageCode = packageId || null
    const payload: Record<string, unknown> = {
      sku: target.sku,
      name: target.name,
      clientId,
      defaultPackageCode: packageCode,
      // Scope the weight/dims push to this order's qty so saving a default for
      // one qty (e.g. a 1-pack) never overwrites another qty's box/weight.
      appliesToQty: target.qty,
    }
    if (options.recalcGroup) payload.recalcGroup = true
    if (skuWeightOz > 0) payload.weightOz = skuWeightOz
    if (hasCompleteDims(dims)) {
      payload.length = dims.length
      payload.width = dims.width
      payload.height = dims.height
    }
    const saved = await apiClient.saveProductDefaultsV2(payload)
    const savedRow = toRecord(saved)
    if (!savedRow || toStringValue(savedRow.sku) !== target.sku) {
      throw new Error('SKU defaults were not saved')
    }
    const confirmed = await apiClient.fetchProductsBySku(target.sku)
    assertSavedProductDefaults(confirmed, {
      sku: target.sku,
      weightOz: skuWeightOz,
      length: hasCompleteDims(dims) ? dims.length : 0,
      width: hasCompleteDims(dims) ? dims.width : 0,
      height: hasCompleteDims(dims) ? dims.height : 0,
      defaultPackageCode: packageCode,
    })

    // PS-121: explicit save → announce + re-poll so same-SKU+qty sibling rates refresh.
    if (options.recalcGroup) {
      announceAndRepollGroupRecalc(savedRow, `Saved dims & weight for ${target.sku}`)
    }

    return target.sku
  }

  async function autoSavePanelSkuDefaults(
    packageId: string | null,
    options: Parameters<typeof savePanelSkuDefaults>[1] = {},
  ) {
    try {
      return await savePanelSkuDefaults(packageId, { ...options, silent: true })
    } catch (error) {
      console.warn('[orders] automatic SKU defaults save failed:', error)
      return null
    }
  }

  async function ensurePanelPackageForDims(options: { saveSku?: boolean; silent?: boolean } = {}) {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment') return panelForm.packageId

    const dims = getPanelDims()
    if (!hasCompleteDims(dims)) return panelForm.packageId

    let packageId = getMatchedPackageIdByDimensions(dims, packages)

    if (!packageId) {
      const response = await apiClient.autoCreatePackageByDimensions({
        length: dims.length,
        width: dims.width,
        height: dims.height,
      })
      const pkg = response?.data ?? response?.package ?? response
      packageId = getPackageIdentifier(pkg)

      if (!packageId) {
        if (!options.silent) showToast('Could not create package for those dimensions', 'error')
        return panelForm.packageId
      }

      mergePackageIntoState(pkg)
    }

    setPanelForm((current) => (
      current.packageId === packageId ? current : { ...current, packageId }
    ))

    await apiClient.setOrderSelectedPackageId(panelOrder.orderId, Number.parseInt(packageId, 10))

    if (options.saveSku) {
      await savePanelSkuDefaults(packageId, { silent: true })
    }

    return packageId
  }

  async function saveColumnPrefsToServer(nextPrefs: ColumnPrefs) {
    columnPrefsRef.current = nextPrefs
    setColumnPrefs(nextPrefs)
    writeLocalColumnPrefs(nextPrefs)
    try {
      await apiClient.saveColumnPrefs(nextPrefs)
    } catch {
      showToast('Failed to save column preferences', 'error')
    }
  }

  function getLatestColumnPrefs() {
    return resolvedColumnPrefsRef.current ?? resolvedColumnPrefs
  }

  function getPersistableHiddenColumns(hiddenColumns: Set<TableColumnKey>) {
    const nextHidden = new Set(hiddenColumns)
    if (currentStatusRef.current !== 'awaiting_shipment') nextHidden.delete('age')
    return nextHidden
  }

  function buildSavedColumnPrefs(
    columns: Array<{ key: TableColumnKey; label: string; width: number }>,
    hiddenColumns: Set<TableColumnKey>,
    widths: Record<TableColumnKey, number>,
  ) {
    return buildColumnPrefsForStatus(
      columnPrefsRef.current,
      currentStatusRef.current,
      columns as any,
      getPersistableHiddenColumns(hiddenColumns) as any,
      widths,
    )
  }

  function buildMovedColumnPrefs(sourceKey: TableColumnKey, targetKey: TableColumnKey) {
    const prefs = getLatestColumnPrefs()
    // PS-317: the pure splice (source removed, reinserted at the target's slot; null when invalid /
    // the immovable 'select' column) lives in orders/column-reorder.ts under a focused unit guard.
    const nextOrdered = computeReorderedColumns(prefs.orderedColumns, sourceKey, targetKey)
    if (!nextOrdered) return null
    return buildSavedColumnPrefs(nextOrdered, prefs.hiddenColumns, prefs.widths as any)
  }

  function moveColumn(sourceKey: TableColumnKey, targetKey: TableColumnKey) {
    const nextPrefs = buildMovedColumnPrefs(sourceKey, targetKey)
    if (!nextPrefs) return
    void saveColumnPrefsToServer(nextPrefs)
  }

  function handleHeaderClick(column: TableColumn) {
    if (suppressHeaderClickRef.current) {
      suppressHeaderClickRef.current = false
      return
    }
    if (column.sort == null) return
    toggleSort(column.sort as SortKey)
  }

  function handleHeaderKeyDown(event: React.KeyboardEvent<HTMLTableCellElement>, column: TableColumn) {
    if (column.key === 'select') return

    if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      resizeColumnByKeyboard(column, event.key === 'ArrowRight' ? 10 : -10)
      return
    }

    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      const currentIndex = visibleColumns.findIndex((candidate) => candidate.key === column.key)
      const targetIndex = event.key === 'ArrowRight' ? currentIndex + 1 : currentIndex - 1
      const targetColumn = visibleColumns[targetIndex]
      if (targetColumn && targetColumn.key !== 'select') moveColumn(column.key, targetColumn.key)
      return
    }

    if ((event.key === 'Enter' || event.key === ' ') && column.sort != null) {
      event.preventDefault()
      handleHeaderClick(column)
    }
  }

  async function hydrateQueue(forceOpen = false) {
    setQueueLoading(true)
    try {
      const payload = await apiClient.fetchQueue(queueClientId, queueHistoryVisible)
      setQueueEntries(getQueuePayloadEntries(payload))
      setQueueEntriesClientId(queueClientId)
      if (forceOpen) setQueueOpen(true)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to load print queue', 'error')
    } finally {
      setQueueLoading(false)
    }
  }

  function buildQueueSendOrderPayload(order: OrderSummaryDto, options: { existingLabelOnly?: boolean; batchTestMode?: boolean; labelPayloadOverrides?: Map<number, Record<string, unknown>> } = {}) {
    if (order.clientId == null) {
      return { payload: null, items: [], error: 'Missing client id', order }
    }

    const labelUrl = getQueueableLabelUrl(order.label?.labelUrl)
    const queuePayload = buildQueueAddPayload(order, labelUrl ?? '')
    // PS-109: preserve the per-line description (product name) through batch-send.
    // buildQueueAddPayload already resolves it; re-mapping to {sku, qty} dropped it,
    // which made multi-SKU batch headers fall back to SKU as the card title (the
    // "spanish-100 / sku: spanish-100" duplicate). Keep no-SKU eBay lines too
    // (sku may be '' — filter on sku OR description so PS-070 lines survive).
    const multiSkuData = Array.isArray(queuePayload.multi_sku_data)
      ? queuePayload.multi_sku_data
        .map((item) => ({
          sku: toStringValue(item?.sku) ?? '',
          description: toStringValue(item?.description) ?? '',
          qty: toNumberValue(item?.qty) ?? 1,
        }))
        .filter((item) => item.sku || item.description)
      : null
    const payload: Record<string, unknown> = {
      order_id: order.orderId,
      client_id: order.clientId,
      order_number: queuePayload.order_number,
      sku_group_id: queuePayload.sku_group_id,
      primary_sku: queuePayload.primary_sku,
      item_description: queuePayload.item_description,
      order_qty: queuePayload.order_qty,
      multi_sku_data: multiSkuData,
    }

    if (labelUrl) {
      payload.label_url = labelUrl
    } else {
      if (options.existingLabelOnly) {
        return { payload: null, items: [], error: 'Label URL is not queueable for this order', order }
      }

      const orderDetail = orderDetailsById.get(order.orderId) ?? null
      if (isShopifySourcedOrder(order, orderDetail)) {
        const dims = getDimensions(order, orderDetail)
        const weightOz = getOrderWeightOz(order, orderDetail)
        if (!weightOz) {
          return { payload: null, items: [], error: 'Missing shipment weight for Shopify label purchase', order }
        }
        if (!dims?.length || !dims.width || !dims.height) {
          return { payload: null, items: [], error: 'Missing package dimensions for Shopify label purchase', order }
        }
        payload.label = options.labelPayloadOverrides?.get(order.orderId) ?? {
          provider: 'shopify_shipping',
          weightOz,
          length: dims.length,
          width: dims.width,
          height: dims.height,
          notifyCustomer: false,
          testLabel: Boolean(options.batchTestMode) || isBackendTestOrder(order),
        }
        return {
          payload,
          items: getActiveItems(order, orderDetail),
          error: null,
          order,
        }
      }

      // PS-286 (slice): an order with no already-bought queueable label would have
      // a label payload built BELOW from order.bestRate and handed to the purchase
      // boundary. Gate that on the SAME backend rate verdict the Awaiting "Best
      // Rate" column consumes — so a stale / incomplete / expired / eligibility-
      // mismatched saved rate is treated as NOT queueable-as-current and skipped
      // with the column's exact actionable reason, instead of silently buying a
      // rate the column is simultaneously refusing to show as a dollar figure.
      //
      // Scope: AWAITING rows only (the verdict is awaiting-only — no shipped path is
      // touched), real (non-test) orders, and only when the caller did NOT supply a
      // live panel payload override (PS-204: the side-panel Print-to-Queue retry
      // hands a freshly re-rated proof, which is current by construction and must
      // not be blocked by the saved-DTO verdict).
      const hasLivePanelOverride = options.labelPayloadOverrides?.has(order.orderId) === true
      if (
        order.orderStatus === 'awaiting_shipment' &&
        !isBackendTestOrder(order) &&
        !hasLivePanelOverride
      ) {
        const request = getAutoBestRateRequest(order)
        const savedRate = getSavedBestRateRecord(order)
        const workflowRecord = toRecord(getBestRateWorkflowModel(order))
        const dims = getDimensions(order, orderDetailsById.get(order.orderId) ?? null)
        const hasDimsAndWeight =
          hasCompleteDims(dims) && Boolean(order.weight?.value && order.weight.value > 0)
        const preflight = request && savedRate
          ? classifyPrintQueuePreflightForSavedRate({
              shippingProviderId: toNumberValue(savedRate.shippingProviderId),
              hasSavedBestRate: hasAnySavedBestRateForDisplay(order),
              hasDimsAndWeight,
              clientRequestKey: toStringValue(savedRate.clientRequestKey),
              requestKey: request.key,
              hasBackendIssuedRateProof: hasBackendIssuedRateProof(savedRate),
              isComplete: savedRate.isComplete === true,
              cacheExpiresAt: toStringValue(savedRate.cacheExpiresAt),
              eligibilityVersion: toStringValue(savedRate.eligibilityVersion),
              requiredEligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
              matchType: toStringValue(savedRate.matchType),
              baseAmount: getRateBaseAmount(savedRate),
              backendWorkflowCanUseSavedRate: toRecord(workflowRecord?.allowedActions)?.canUseSavedRate === true,
              backendWorkflowCanDisplayFinalRate:
                typeof workflowRecord?.canDisplayFinalRate === 'boolean' ? workflowRecord.canDisplayFinalRate : null,
              backendWorkflowCanUseDisplayedRateForPurchase:
                typeof workflowRecord?.canUseDisplayedRateForPurchase === 'boolean'
                  ? workflowRecord.canUseDisplayedRateForPurchase
                  : null,
              backendSavedRateDisplay: toStringValue(workflowRecord?.savedRateDisplay),
            })
          : classifyPrintQueuePreflightFromAwaitingState(
              getAwaitingBestRateDisplayState(order),
            )
        if (!preflight.queueableAsCurrent) {
          const reasonLabel = AWAITING_BEST_RATE_STATE_LABELS[preflight.state] || 'Recalculate required'
          return {
            payload: null,
            items: [],
            error: `Saved rate not current (${reasonLabel}) — recalculate before queueing; no postage was purchased`,
            order,
          }
        }
      }

      const bestRate = order.bestRate
      const selectedRate = order.selectedRate
      const shippingProviderId = toNumberValue((bestRate as any)?.shippingProviderId) ?? selectedRate?.shippingProviderId ?? order.label?.shippingProviderId ?? null
      const serviceCode = getShippingString(order, 'serviceCode') ?? toStringValue((bestRate as any)?.serviceCode) ?? selectedRate?.serviceCode
      const serviceName = toStringValue((bestRate as any)?.serviceName) ?? toStringValue((bestRate as any)?.service_type) ?? selectedRate?.serviceName ?? selectedRate?.serviceType
      const serviceType = toStringValue((bestRate as any)?.serviceType) ?? toStringValue((bestRate as any)?.service_type) ?? selectedRate?.serviceType ?? selectedRate?.serviceName
      const carrierCode = getShippingString(order, 'carrierCode') ?? toStringValue((bestRate as any)?.carrierCode) ?? selectedRate?.carrierCode
      const carrierName = toStringValue((bestRate as any)?.carrierName) ?? toStringValue((bestRate as any)?.carrier_name) ?? selectedRate?.carrierName
      const dims = getDimensions(order, orderDetail)
      const weightOz = getOrderWeightOz(order, orderDetail)
      // PS-186: money path — backend fact only (heuristics must never shape a label payload).
      const orderIsTest = isBackendTestOrder(order)
      const effectiveServiceCode = serviceCode ?? (orderIsTest ? TEST_SERVICE_CODE : undefined)
      const effectiveCarrierCode = carrierCode ?? (orderIsTest ? TEST_CARRIER_CODE : undefined)
      const effectiveWeightOz = weightOz > 0 ? weightOz : orderIsTest ? 1 : 0
      const shippingOptions = buildOrderShippingOptionsPayload(order)

      payload.label = options.labelPayloadOverrides?.get(order.orderId) ?? {
        serviceCode: effectiveServiceCode,
        carrierCode: effectiveCarrierCode,
        carrierName: carrierName ?? undefined,
        serviceName: serviceName ?? undefined,
        serviceType: serviceType ?? undefined,
        packageCode: 'package',
        shippingProviderId: shippingProviderId ?? undefined,
        weightOz: effectiveWeightOz > 0 ? effectiveWeightOz : undefined,
        length: dims?.length,
        width: dims?.width,
        height: dims?.height,
        confirmation: shippingOptions.confirmation,
        insuranceProvider: shippingOptions.insuranceProvider,
        insuredValue: shippingOptions.insuredValue,
        // PS-204: proof candidates filtered to the account this batch payload
        // charges (shippingProviderId above) — same binding the panel payload
        // and the backend boundary enforce.
        selectedRateProof: buildSelectedRateProofPayload(order, bestRate ?? selectedRate, shippingProviderId),
        ...buildRateQuoteRefForOrder(order, bestRate ?? selectedRate, shippingProviderId),
        testLabel: Boolean(options.batchTestMode) || orderIsTest,
      }
    }

    return {
      payload,
      items: getActiveItems(order, orderDetailsById.get(order.orderId) ?? null),
      error: null,
      order,
    }
  }

  async function pollBackendQueueSendJob(
    backendJobId: string,
    progressTotal: number,
  ) {
    let status: any = null
    while (true) {
      status = await apiClient.fetchQueueSendJobStatus(backendJobId)
      const current = toNumberValue(status.current) ?? 0
      const skipped = toNumberValue(status.skipped) ?? 0
      const failed = toNumberValue(status.failed) ?? 0
      setQueueActionProgress((active) => active
        ? {
          ...active,
          label: status.status === 'done' ? 'Refreshing queue' : 'Sending to queue',
          total: progressTotal,
          completed: Math.min(progressTotal, current),
          skipped,
          failed,
        }
        : active
      )

      if (status.status === 'done') return status
      if (status.status === 'interrupted') {
        setQueueActionProgress((active) => active
          ? {
            ...active,
            label: 'Queue interrupted',
            total: progressTotal,
            completed: Math.min(progressTotal, current),
            skipped,
            failed,
          }
          : active
        )
        const interrupted = new Error(status.message || 'Queue job interrupted before it could finish')
        ;(interrupted as Error & { code?: string }).code = 'QUEUE_SEND_INTERRUPTED'
        throw interrupted
      }
      if (status.status === 'error') {
        throw new Error(status.error || status.message || 'Queue send failed')
      }
      await yieldToBrowser(BACKEND_QUEUE_SEND_POLL_MS)
    }
  }

  async function refreshQueueAfterBackendStatus(status: any) {
    const queued = toNumberValue(status?.queued) ?? 0
    if (queued <= 0) return

    setQueueActionProgressLabel('Refreshing queue')
    setQueueLoading(true)
    try {
      const payload = await apiClient.fetchQueue(queueClientId, queueHistoryVisible)
      setQueueEntries(getQueuePayloadEntries(payload))
      setQueueEntriesClientId(queueClientId)
      setQueueOpen(true)
    } finally {
      setQueueLoading(false)
    }
  }

  // Batch-print pipeline: resolve the provider id the order would ship on (best
  // rate → selected rate → any existing label). Re-added as a live helper for the
  // chain's needsOverride proof binding (PS-204) — pure DTO read, no route policy.
  function resolveOrderShippingProviderId(order: OrderSummaryDto): number | null {
    return (
      toNumberValue((order.bestRate as any)?.shippingProviderId) ??
      order.selectedRate?.shippingProviderId ??
      order.label?.shippingProviderId ??
      null
    )
  }

  // Batch-print pipeline: build the label-payload override for an order whose saved
  // rate could not serve as proof, from the FRESH strict-recalc rate. Mirrors the
  // legacy print loop's payload (PS-204: proof and provider id derive from the SAME
  // fresh rate, so account binding is coherent by construction). Returns null when
  // the fresh rate still cannot prove a purchase — the order is skipped, no postage.
  function buildBatchPrintOverridePayload(order: OrderSummaryDto, freshRate: unknown): Record<string, unknown> | null {
    const rate = freshRate as Record<string, unknown> | null
    if (!rate) return null
    const shippingProviderId = toNumberValue((rate as any)?.shippingProviderId)
      ?? order.selectedRate?.shippingProviderId
      ?? order.label?.shippingProviderId
      ?? null
    const serviceCode = getShippingString(order, 'serviceCode') ?? toStringValue((rate as any)?.serviceCode) ?? order.selectedRate?.serviceCode
    const carrierCode = getShippingString(order, 'carrierCode') ?? toStringValue((rate as any)?.carrierCode) ?? order.selectedRate?.carrierCode
    const orderDetail = orderDetailsById.get(order.orderId) ?? null
    const dims = getDimensions(order, orderDetail)
    const weightOz = getOrderWeightOz(order, orderDetail)
    const shippingOptions = buildOrderShippingOptionsPayload(order)
    const selectedRateProof = buildSelectedRateProofPayload(order, rate)
    if (!selectedRateProof || !serviceCode || !carrierCode || shippingProviderId == null) return null
    return {
      serviceCode,
      carrierCode,
      packageCode: 'package',
      shippingProviderId,
      weightOz: weightOz > 0 ? weightOz : undefined,
      length: dims?.length,
      width: dims?.width,
      height: dims?.height,
      confirmation: shippingOptions.confirmation,
      insuranceProvider: shippingOptions.insuranceProvider,
      insuredValue: shippingOptions.insuredValue,
      selectedRateProof,
      ...buildRateQuoteRefForOrder(order, rate, shippingProviderId),
      testLabel: batchTestMode || isBackendTestOrder(order),
    }
  }

  async function sendOrdersToQueueBackend(
    jobOrders: OrderSummaryDto[],
    options: {
      kind: PersistentQueueJobKind
      label?: string
      batchTestMode?: boolean
      existingLabelOnly?: boolean
      labelPayloadOverrides?: Map<number, Record<string, unknown>>
      // Batch-print pipeline: the create-print chain owns refetch timing (fade
      // first, refetch per-row after the 30s transition) — it passes true here.
      deferOrdersRefetch?: boolean
    },
  ) {
    const queueJobId = beginPersistentQueueJob(options.kind, jobOrders, {
      label: options.label ?? 'Sending to queue',
      batchTestMode: options.batchTestMode,
    })

    // PS-359: OrdersView no longer computes a direct-vs-backend route or asks
    // for a route plan. Every selected order is sent as backend intent; the
    // Print Queue owner performs create/recover/queue routing.
    const backendJobOrders = jobOrders

    const prepared = backendJobOrders.map((order) => buildQueueSendOrderPayload(order, options))
    const skipped = prepared.filter((entry) => !entry.payload)
    const skippedErrors = skipped
      .map((entry) => {
        const reason = toStringValue(entry.error)
        if (!reason) return null
        const orderNumber = entry.order.orderNumber ?? entry.order.orderId
        return orderNumber ? `Order ${orderNumber}: ${reason}` : reason
      })
      .filter((message): message is string => Boolean(message))
    const preflightSkips: Array<Record<string, unknown>> = skipped
      .flatMap((entry) => {
        const reason = toStringValue(entry.error)
        if (!reason) return []
        return [{
          order_id: entry.order.orderId,
          client_id: entry.order.clientId,
          order_number: entry.order.orderNumber ?? String(entry.order.orderId),
          reason,
          retry_eligible: /saved rate not current|recalculate/i.test(reason),
          retry_reason: /saved rate not current|recalculate/i.test(reason)
            ? 'stale_or_mismatched_rate_proof'
            : 'frontend_preflight',
        }]
      })
    const queueOrders = prepared.filter((entry) => entry.payload).map((entry) => entry.payload as Record<string, unknown>)
    let finalStatus: any = null
    let queueInterrupted = false

    for (const entry of skipped) {
      markPersistentQueueJobOrder(queueJobId, entry.order.orderId, false)
    }

    try {
      if (queueOrders.length > 0 || preflightSkips.length > 0) {
        const started = await apiClient.startQueueSendJob({
          orders: queueOrders,
          preflight_skips: preflightSkips,
        })
        attachPersistentQueueBackendJob(queueJobId, started.job_id)
        try {
          finalStatus = await pollBackendQueueSendJob(
            started.job_id,
            toNumberValue(started.total) ?? Math.max(jobOrders.length, 1),
          )
        } catch (error) {
          queueInterrupted = (error as { code?: unknown } | null)?.code === 'QUEUE_SEND_INTERRUPTED'
          throw error
        }
        await refreshQueueAfterBackendStatus(finalStatus)
      }

      // Batch-print pipeline: the create-print chain owns refetch timing (fade first,
      // per-row refetch after the 30s transition) — it passes deferOrdersRefetch.
      if (!options.deferOrdersRefetch) {
        try {
          await refetchOrders()
        } catch (error) {
          console.warn('[print-queue] post-queue orders refresh failed', error instanceof Error ? error.message : error)
          showToast('Queue result saved, but the Orders table refresh timed out. Use Retry if the table does not reload.', 'error')
        }
      }
    } finally {
      setQueueLoading(false)
      finishPersistentQueueJob(queueJobId)
      const queued = toNumberValue(finalStatus?.queued) ?? 0
      finishQueueActionProgress(
        queueInterrupted ? 'Queue interrupted' : queued > 0 ? 'Queue updated' : 'Queue checked',
        queueInterrupted ? { complete: false } : {},
      )
    }

    const backendResults = (finalStatus?.results ?? []) as Array<Record<string, unknown>>
    const successOrderIds = new Set(
      backendResults
        .filter((result) => result.success === true)
        .map((result) => toNumberValue(result.orderId ?? result.order_id))
        .filter((orderId): orderId is number => orderId != null),
    )
    const queuedItems = prepared
      .filter((entry) => successOrderIds.has(entry.order.orderId))
      .flatMap((entry) => entry.items)

    // Per user override unlock shipped data on 2026-05-23: surface the backend's
    // per-order queue-send failure reason instead of swallowing it. Without this
    // a real reason ("Missing label payload", a create-label/rate error, or a
    // non-queueable label URL) collapsed into a generic "Label was not added to
    // the print queue" toast and the operator had no way to see why. Read-only:
    // this only reads results[].error already returned by the queue-send job.
    const formatBackendResultReason = (result: Record<string, unknown>) => {
      const orderId = toNumberValue(result.orderId ?? result.order_id)
      const reason = toStringValue(result.skipReason ?? result.skip_reason ?? result.error)
      if (!reason) return null
      const resultOrderNumber = toStringValue(result.orderNumber ?? result.order_number)
      const preparedOrderNumber = prepared.find((entry) => entry.order.orderId === orderId)?.order.orderNumber
      const orderNumber = resultOrderNumber ?? preparedOrderNumber
      return orderNumber ? `Order ${orderNumber}: ${reason}` : reason
    }

    const backendSkippedErrors = backendResults
      .filter((result) => result.success === false && result.skipped === true)
      .map(formatBackendResultReason)
      .filter((message): message is string => Boolean(message))

    const backendErrors = backendResults
      .filter((result) => result.success === false && result.skipped !== true)
      .map(formatBackendResultReason)
      .filter((message): message is string => Boolean(message))

    const skippedResultErrors = backendSkippedErrors.length > 0 ? backendSkippedErrors : skippedErrors

    // PS-191: backend-owned retry eligibility per failed order. Callers use
    // this to PROMPT a re-rate (operator reviews + clicks again) — never to
    // auto-repurchase.
    const retryEligibleOrderIds = new Set(
      backendResults
        .filter((result) => result.success === false && result.retryEligible === true)
        .map((result) => toNumberValue(result.orderId ?? result.order_id))
        .filter((orderId): orderId is number => orderId != null),
    )

    return {
      queued: toNumberValue(finalStatus?.queued) ?? 0,
      skipped: toNumberValue(finalStatus?.skipped) ?? skipped.length,
      failed: toNumberValue(finalStatus?.failed) ?? 0,
      queuedItems,
      skippedErrors: skippedResultErrors,
      failedErrors: backendErrors,
      // Batch-print pipeline: the create-print chain prints exactly the entries
      // THIS job queued, and fades exactly the orders the backend reported bought.
      queuedEntryIds: Array.isArray(finalStatus?.queued_entry_ids)
        ? (finalStatus.queued_entry_ids as unknown[]).filter((id): id is string => typeof id === 'string')
        : [],
      successOrderIds,
      retryEligibleOrderIds,
    }
  }

  async function queueExistingLabels(orderIds: number[]) {
    if (orderIds.length === 0) {
      await hydrateQueue(true)
      return
    }

    // O(1) lookups instead of N×O(N) `orders.find` inside the loop.
    const orderById = new Map(orders.map((order) => [order.orderId, order]))
    // Per user override unlock shipped data on 2026-05-23: shipped side-panel queueing must use the open panel order even when it is not on the current page list.
    if (panelOrder && orderIds.includes(panelOrder.orderId)) {
      orderById.set(panelOrder.orderId, panelOrder)
    }
    const jobOrders = orderIds
      .map((orderId) => orderById.get(orderId))
      .filter(Boolean) as OrderSummaryDto[]
    if (jobOrders.length === 0) {
      showToast('Could not find the selected order to queue. Reopen the order and try again.', 'error')
      return
    }

    try {
      const result = await sendOrdersToQueueBackend(jobOrders, {
        kind: 'existing-labels',
        label: 'Sending to queue',
        existingLabelOnly: true,
      })
      if (result.queued > 0 || result.skipped > 0 || result.failed > 0) {
        showToast(formatQueueSendResultToast(result), queueSendToastType(result))
      } else {
        showToast(result.skippedErrors[0] ?? result.failedErrors[0] ?? 'Label URL is not queueable - nothing was added to the print queue', 'error')
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to send to queue', 'error')
    }
  }

  async function handleTopbarLabels() {
    if (selectedOrderIds.length === 0) {
      await hydrateQueue(true)
      return
    }
    await queueExistingLabels(selectedOrderIds)
  }

  function openLabelPdfPlaceholder() {
    const popup = window.open('', '_blank')
    if (!popup) return null
    try {
      popup.document.title = 'Creating label PDF'
      popup.document.body.style.margin = '0'
      popup.document.body.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      popup.document.body.style.background = '#f8fafc'
      popup.document.body.innerHTML = `
        <main style="min-height:100vh;display:grid;place-items:center;color:#0f172a">
          <section style="padding:24px;text-align:center">
            <strong style="display:block;font-size:16px;margin-bottom:8px">Creating label PDF...</strong>
            <span style="color:#64748b;font-size:13px">This tab will open the label as soon as ShipStation returns it.</span>
          </section>
        </main>
      `
    } catch {
      // Some browsers restrict writing to the newly opened tab. Keeping the
      // blank tab still preserves the user gesture for the later PDF redirect.
    }
    return popup
  }

  // 2026-05-14: routes through apiClient.openLabelPdf which fetches
  // auth-gated /labels endpoints with the Bearer token, opens via
  // blob: URL, and only falls back to window.open for external CDN
  // URLs (ShipStation downloads). Previously a raw `window.open(labelUrl)`
  // here would silently 401 on any auth-gated label URL — Chrome
  // surfaces that as the misleading "Check internet connection"
  // error in the download manager. Boss-reported on this date.
  function openLabelPdfUrl(labelUrl: string, popup: Window | null) {
    void apiClient.openLabelPdf(labelUrl, { popup })
  }

  function showLabelPdfPlaceholderMessage(popup: Window | null, title: string, message: string) {
    if (!popup || popup.closed) return
    try {
      popup.document.title = title
      popup.document.body.style.margin = '0'
      popup.document.body.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      popup.document.body.style.background = '#f8fafc'
      popup.document.body.replaceChildren()
      const main = popup.document.createElement('main')
      main.style.minHeight = '100vh'
      main.style.display = 'grid'
      main.style.placeItems = 'center'
      main.style.color = '#0f172a'
      const section = popup.document.createElement('section')
      section.style.padding = '24px'
      section.style.textAlign = 'center'
      const heading = popup.document.createElement('strong')
      heading.style.display = 'block'
      heading.style.fontSize = '16px'
      heading.style.marginBottom = '8px'
      heading.textContent = title
      const body = popup.document.createElement('span')
      body.style.color = '#64748b'
      body.style.fontSize = '13px'
      body.textContent = message
      section.append(heading, body)
      main.append(section)
      popup.document.body.append(main)
    } catch {
      // Nothing else to do; the app toast still explains the outcome.
    }
  }

  // Detects a label-purchase rejection from the shipping purchase boundary
  // (PS-095/PS-098). Every reason here means the same thing for an operator: the
  // order's saved rate is stale/unproven and must be re-rated before postage is
  // bought. We surface a friendly "recalculate then print" flow instead of the
  // PS-191: retry eligibility is a BACKEND fact (retryEligible/retryReason on
  // purchase-failure responses, derived structurally from the proof-error
  // code — see classifyLabelPurchaseRetry). The old regex over error MESSAGE
  // text is deleted; this only reads structured fields. The code fallback
  // covers deploy skew (older responses without the flag).
  function isRetryEligibleRateFailure(error: unknown): boolean {
    const e = error as { retryEligible?: unknown; code?: unknown } | null | undefined
    if (!e || typeof e !== 'object') return false
    if (typeof e.retryEligible === 'boolean') return e.retryEligible
    return e.code === 'SELECTED_RATE_PROOF_INVALID'
  }

  // One-click re-rate: when a purchase is refused for a stale/unproven rate,
  // refresh the order's best rate (which re-stamps the request fingerprint)
  // and PROMPT the operator to review it and click again. PS-191: every retry
  // requires that confirmation — no caller may auto-continue the purchase
  // with the refreshed (possibly higher-priced) rate.
  async function refreshStaleRateForOrder(
    order: OrderSummaryDto,
    nextActionLabel = 'Create + Print Label',
  ) {
    const request = getAutoBestRateRequest(order)
    if (!request) {
      showToast(RATE_PROOF_RETRY_MESSAGE, 'error')
      return null
    }
    showToast('Rate is out of date — recalculating…', 'info')
    try {
      const result = await runStrictBestRateRecalculation(order, request, {
        updatePanel: panelOrderId === order.orderId,
        refetch: true,
      })
      if (result.status === 'updated') {
        showToast(
          `Rate refreshed — review it and click ${nextActionLabel} again.`,
          'success',
        )
        return result.rate ?? null
      } else if (result.status === 'cleared') {
        showToast('No rates are available for this order right now. Adjust the package/dimensions and try again.', 'error')
      } else {
        showToast(RATE_PROOF_RETRY_MESSAGE, 'error')
      }
    } catch (refreshError) {
      console.warn('[rate-proof] refresh before label failed:', refreshError instanceof Error ? refreshError.message : refreshError)
      showToast(RATE_PROOF_RETRY_MESSAGE, 'error')
    }
    return null
  }

  function isShopifySourcedOrder(order: OrderSummaryDto | null | undefined, detail?: OrderFullDto | null): boolean {
    const raw = toRecord(order?.raw)
    const detailRaw = toRecord(detail?.raw)
    const shipping = toRecord(order?.shipping)
    const canonical = toRecord(order?.canonicalOrder)
    const candidates = [
      order?.sourceProvider,
      order?.source_provider,
      order?.marketplace,
      order?.storeProvider,
      shipping?.sourceProvider,
      shipping?.provider,
      canonical?.sourceProvider,
      raw?.sourceProvider,
      raw?.source_provider,
      raw?.source,
      raw?.provider,
      raw?.marketplace,
      detailRaw?.sourceProvider,
      detailRaw?.source_provider,
      detailRaw?.source,
      detailRaw?.provider,
      detailRaw?.marketplace,
    ]
    return candidates.some((candidate) => String(candidate ?? '').trim().toLowerCase() === 'shopify')
  }

  function hasShopifyLabelPurchaseIntent(batchOrders: OrderSummaryDto[]): boolean {
    return batchOrders.some((order) => {
      if (getQueueableLabelUrl(order.label?.labelUrl)) return false
      return isShopifySourcedOrder(order, orderDetailsById.get(order.orderId) ?? null)
    })
  }

  async function createOrQueueLabel(mode: 'print' | 'queue' | 'test', order = panelOrder) {
    if (!order) {
      showToast('No order selected', 'error')
      return null
    }

    const orderDetail = orderDetailsById.get(order.orderId) ?? panelDetail
    // PS-186: money path — backend fact only. An explicit mode==='test' on a real client now
    // gets a visible TEST_LABEL_REJECTED 409 instead of a silent fake label.
    const isTest = isBackendTestOrder(order)
    const shippingProviderId = Number.parseInt(panelForm.shipAccountId, 10)
    const weightOz = getPanelWeightOz() || getOrderWeightOz(order, orderDetail)
    const panelDims = getPanelDims()
    const savedDims = getDimensions(order, orderDetail)
    const length = panelDims.length || savedDims?.length || 0
    const width = panelDims.width || savedDims?.width || 0
    const height = panelDims.height || savedDims?.height || 0
    const labelDims = { length, width, height }
    const account = shippingAccounts.find((candidate) => candidate.shippingProviderId === shippingProviderId)
    if (!isTest && (!shippingProviderId || !account)) {
      showToast('Select a carrier account', 'error')
      return null
    }
    if (!isTest && !panelForm.serviceCode) {
      showToast('Select a shipping service', 'error')
      return null
    }
    if (!weightOz) {
      showToast('Enter shipment weight', 'error')
      return null
    }

    const location = locations.find((candidate) => String(candidate.locationId) === panelForm.locationId) ?? null
    const shipTo = getShipTo(order, orderDetail)
    const selectedPackage = packages.find((candidate) => String(candidate.packageId) === panelForm.packageId)
    const testSelectedRate = isTest ? (panelRatePreview[0] ?? order.bestRate ?? null) : null
    const testCarrierCode = toStringValue(testSelectedRate?.carrierCode) ?? TEST_CARRIER_CODE
    const testServiceCode = panelForm.serviceCode || toStringValue(testSelectedRate?.serviceCode) || TEST_SERVICE_CODE
    const shippingOptions = buildPanelShippingOptionsPayload()

    const payload: CreateLabelRequestDto = {
      orderId: order.orderId,
      orderNumber: order.orderNumber ?? undefined,
      carrierCode: isTest ? testCarrierCode : account!.code,
      serviceCode: isTest ? testServiceCode : panelForm.serviceCode,
      // PS-078 req 2/invariant "display best-rate and label-payload selected-rate
      // must not diverge": the non-test label name/type come ONLY from the
      // CURRENT panel rate preview or the operator's selected serviceCode — never
      // from the (possibly stale) saved order.bestRate. The charged tuple
      // (carrierCode/serviceCode/shippingProviderId/dims) is already the panel
      // selection above; this keeps the human-readable strings consistent with it.
      //
      // PS-078 req 4 — DECISION (DJ, 2026-06-04): "proceed with current operator
      // selection." Label creation is NOT hard-blocked when the displayed rate is
      // mid-recalculation/stale, BECAUSE the charged tuple here is the operator's
      // explicit current panel selection (account.code / panelForm.serviceCode /
      // shippingProviderId / current dims), NOT a saved/cached/alternate rate. The
      // saved best rate is only a display signal (shown as calculating/unresolved
      // when stale via classifyAwaitingRateCellState) and can never become the
      // selected rate. Do NOT add a stale-rate block here without DJ's sign-off.
      //
      // PS-204 refinement (DJ-signed via the PS-204 card, 2026-06-12): the req-4
      // decision stands for STALENESS, but the PROOF attached below is now
      // account-bound — a rate from a different account than the charged
      // shippingProviderId is never sent as proof, and a cross-account purchase
      // is blocked (here with a re-rate toast; independently at the backend
      // boundary). Proceeding with the operator's selection never meant
      // charging account A on account B's proof.
      serviceName: isTest
        ? toStringValue(testSelectedRate?.serviceName) ?? testServiceCode
        : toStringValue(panelRatePreview[0]?.serviceName) ?? panelForm.serviceCode,
      serviceType: isTest
        ? toStringValue((testSelectedRate as any)?.serviceType) ?? toStringValue((testSelectedRate as any)?.service_type) ?? testServiceCode
        : toStringValue((panelRatePreview[0] as any)?.serviceType) ?? toStringValue((panelRatePreview[0] as any)?.service_type) ?? panelForm.serviceCode,
      shippingProviderId: isTest ? null : shippingProviderId,
      packageCode: 'package',
      customPackageId: selectedPackage && selectedPackage.source !== 'ss_carrier' ? selectedPackage.packageId : null,
      weightOz,
      length,
      width,
      height,
      confirmation: shippingOptions.confirmation,
      insuranceProvider: shippingOptions.insuranceProvider,
      insuredValue: shippingOptions.insuredValue ?? undefined,
      // PS-204: the proof/quote-ref candidates are FILTERED to the account the
      // payload charges (shippingProviderId above) — a preview/saved rate from
      // a DIFFERENT account can no longer ride along as "proof" for this
      // purchase (the order-1484 class: pid 10000025 with an se-565377 proof).
      // The backend boundary independently enforces the same binding.
      selectedRateProof: buildSelectedRateProofPayload(order, panelRatePreview[0] ?? order.bestRate ?? order.selectedRate, isTest ? null : shippingProviderId),
      ...buildRateQuoteRefForOrder(order, panelRatePreview[0] ?? order.bestRate ?? order.selectedRate, isTest ? null : shippingProviderId),
      testLabel: isTest || mode === 'test',
      shipTo: {
        name: shipTo.name ?? '',
        company: shipTo.company ?? '',
        street1: shipTo.street1 ?? '',
        street2: shipTo.street2 ?? '',
        city: shipTo.city ?? '',
        state: shipTo.state ?? '',
        postalCode: shipTo.postalCode ?? '',
        country: shipTo.country ?? 'US',
        phone: shipTo.phone ?? '',
      },
      shipFrom: location ? {
        name: location.name,
        company: location.company,
        street1: location.street1,
        street2: location.street2,
        city: location.city,
        state: location.state,
        postalCode: location.postalCode,
        country: location.country,
        phone: location.phone,
      } : undefined,
    }

    // PS-204 UI honesty: if a backend-proven rate EXISTS but belongs to a
    // different account than the dropdown selection, the account filter above
    // produced no proof — surface the real situation and require a re-rate for
    // the chosen account instead of letting the purchase fail server-side with
    // a generic proof error. (No proof at all = unchanged: the backend proof
    // gate rejects exactly as before.)
    if (!isTest && !payload.selectedRateProof && !payload.rateQuoteId) {
      const unfiltered = buildSelectedRateProofPayload(order, panelRatePreview[0] ?? order.bestRate ?? order.selectedRate)
      if (unfiltered) {
        const accountLabel = account?.nickname || account?._label || `account ${shippingProviderId}`
        showToast(
          `The displayed rate belongs to a different carrier account — Browse Rates for ${accountLabel} before purchasing`,
          'error',
        )
        return null
      }
    }

    const workflowRecord = toRecord(getBestRateWorkflowModel(order))
    const usingSavedDisplayedRateProof =
      order.orderStatus === 'awaiting_shipment' &&
      !isTest &&
      !panelRatePreview[0] &&
      Boolean(order.bestRate) &&
      (Boolean(payload.selectedRateProof) || Boolean(payload.rateQuoteId))
    if (
      usingSavedDisplayedRateProof &&
      workflowRecord?.canUseDisplayedRateForPurchase === false
    ) {
      showToast(RATE_EXPIRED_RERATE_MESSAGE, 'error')
      void refreshStaleRateForOrder(order, mode === 'queue' ? 'Print to Queue' : 'Create + Print')
      return null
    }

    const labelPopup = mode === 'queue' ? null : openLabelPdfPlaceholder()
    const schedulePostLabelFollowups = (response: any) => {
      void (async () => {
        const followupsStarted = performance.now()
        try {
          const skuSaveStarted = performance.now()
          await autoSavePanelSkuDefaults(panelForm.packageId || null, {
            order,
            detail: orderDetail,
            weightOz,
            dims: hasCompleteDims(labelDims) ? labelDims : null,
          })
          console.info(`[label-create] frontend SKU default save ${Math.round(performance.now() - skuSaveStarted)}ms`)
        } catch (error) {
          console.warn('[label-create] frontend SKU default save failed:', error instanceof Error ? error.message : error)
        }

        try {
          const refetchStarted = performance.now()
          await refetchOrders()
          console.info(`[label-create] frontend refetchOrders ${Math.round(performance.now() - refetchStarted)}ms`)
        } catch (error) {
          console.warn('[label-create] frontend refetchOrders failed:', error instanceof Error ? error.message : error)
        }

        console.info(`[label-create] frontend post-label followups ${Math.round(performance.now() - followupsStarted)}ms`)
      })()
      return response
    }
    if (singleActionBusyRef.current) {
      // Label/print-queue audit (2026-06-11): a second click while a buy is in flight is already
      // blocked here (no double-charge), but the placeholder PDF tab was opened above (openLabelPdfPlaceholder)
      // before this guard — close it so a double-click doesn't strand an orphan "Creating label
      // PDF..." tab that never resolves.
      labelPopup?.close()
      return null
    }
    singleActionBusyRef.current = true
    setSingleActionBusy(true)
    try {
      if (mode === 'queue') {
        // Per user override unlock shipped data on 2026-05-23: route Print to
        // Queue through the backend create/recover-and-queue path so a label
        // cannot be bought and shipped without queue recovery.
        const result = await sendOrdersToQueueBackend([order], {
          kind: 'existing-labels',
          label: 'Sending to queue',
          labelPayloadOverrides: new Map([[order.orderId, payload as unknown as Record<string, unknown>]]),
        })
        if (result.queued > 0 && result.skipped === 0 && result.failed === 0) {
          showToast(
            formatQueuedOrderToast(
              order.orderNumber ?? order.orderId,
              getActiveItems(order, orderDetailsById.get(order.orderId) ?? null),
            ),
            'success',
          )
        } else {
          const queueErrorMessage = result.skippedErrors[0] ?? result.failedErrors[0]
          // PS-191: NEVER auto-repurchase. The old path re-rated and re-fired
          // the queue purchase with promptForRetry:false — the operator could
          // be charged a higher refreshed rate with zero awareness. Now a
          // backend-flagged retryable failure refreshes the rate and PROMPTS
          // (same UX as Create + Print); the operator reviews and clicks
          // Print to Queue again to confirm the buy.
          if (result.retryEligibleOrderIds.has(order.orderId)) {
            showToast(RATE_EXPIRED_RERATE_MESSAGE, 'error')
            void refreshStaleRateForOrder(order, 'Print to Queue')
          } else if (result.queued > 0 || result.skipped > 0 || result.failed > 0) {
            showToast(formatQueueSendResultToast(result), queueSendToastType(result))
          } else {
            showToast(queueErrorMessage ?? 'Label was not added to the print queue', 'error')
          }
        }
        return schedulePostLabelFollowups({ orderStatus: 'shipped' })
      }

      const labelRequestStarted = performance.now()
      const response = await apiClient.createLabel(payload)
      console.info(`[label-create] frontend apiClient.createLabel ${Math.round(performance.now() - labelRequestStarted)}ms`)
      const queueableLabelUrl = getQueueableLabelUrl(response.labelUrl)
      if (queueableLabelUrl) {
        openLabelPdfUrl(queueableLabelUrl, labelPopup)
        if (response?.meta?.walmartShipmentConfirmed === false) {
          const confirmError = toStringValue(response.meta.walmartShipmentConfirmError)
          showToast(
            `Walmart label created, but Seller Center was not marked shipped${confirmError ? `: ${confirmError}` : ''}. Use Mark as shipped manually for this order.`,
            'error',
          )
          return schedulePostLabelFollowups(response)
        }
        showToast(mode === 'test' ? `🧪 Test label created${response.trackingNumber ? `: ${response.trackingNumber}` : ''}` : `✅ Label created${response.trackingNumber ? `: ${response.trackingNumber}` : ''}`, 'success')
      } else {
        showLabelPdfPlaceholderMessage(labelPopup, 'Label created, but no PDF URL returned', 'ShipStation created the label but did not return a downloadable PDF URL. Try Reprint Label or open it in ShipStation.')
        showToast(response.labelUrl ? 'Label URL is not queueable' : 'Label created but no PDF returned', response.labelUrl ? 'error' : 'info')
      }

      return schedulePostLabelFollowups(response)
    } catch (error) {
      if (mode === 'queue') {
        try {
          if (await queueExistingLabelAfterCreateConflict(order, error)) return null
        } catch (queueError) {
          showToast(queueError instanceof Error ? queueError.message : 'Failed to queue existing label', 'error')
          return null
        }
      }
      if (isRetryEligibleRateFailure(error)) {
        // Stale/unproven rate — don't show the raw reason code. Auto-refresh the
        // rate and prompt the operator to print again (they confirm the buy).
        showLabelPdfPlaceholderMessage(
          labelPopup,
          'Rate is out of date',
          'This order’s saved rate is out of date, so no label was purchased. Refreshing the rate now — review it and click Create + Print Label again.',
        )
        showToast(RATE_EXPIRED_RERATE_MESSAGE, 'error')
        void refreshStaleRateForOrder(order)
        return null
      }
      showLabelPdfPlaceholderMessage(labelPopup, 'Label creation failed', error instanceof Error ? error.message : 'Label creation failed')
      showToast(error instanceof Error ? error.message : 'Label creation failed', 'error')
      return null
    } finally {
      singleActionBusyRef.current = false
      setSingleActionBusy(false)
    }
  }

  async function createOrQueueShopifyLabel(mode: 'print' | 'queue', order = panelOrder) {
    if (!order) {
      showToast('No order selected', 'error')
      return null
    }
    const orderDetail = orderDetailsById.get(order.orderId) ?? panelDetail
    if (!isShopifySourcedOrder(order, orderDetail)) {
      showToast('Shopify labels are only available for Shopify orders', 'error')
      return null
    }
    const hold = orderShippingHold(orderDetail ?? order)
    if (hold?.blocked) {
      showToast(hold.reason || 'Buying a label is blocked for this order', 'error')
      return null
    }

    const weightOz = getPanelWeightOz() || getOrderWeightOz(order, orderDetail)
    const panelDims = getPanelDims()
    const savedDims = getDimensions(order, orderDetail)
    const length = panelDims.length || savedDims?.length || 0
    const width = panelDims.width || savedDims?.width || 0
    const height = panelDims.height || savedDims?.height || 0
    if (!weightOz) {
      showToast('Enter shipment weight', 'error')
      return null
    }
    if (!length || !width || !height) {
      showToast('Enter package dimensions', 'error')
      return null
    }
    if (!window.confirm(SHOPIFY_LABEL_PURCHASE_CONFIRM_MESSAGE)) {
      showToast('Shopify label purchase cancelled', 'info')
      return null
    }

    const selectedPackage = packages.find((candidate) => String(candidate.packageId) === panelForm.packageId)
    const payload = {
      provider: 'shopify_shipping',
      orderId: order.orderId,
      weightOz,
      length,
      width,
      height,
      packageName: toStringValue(selectedPackage?.name) ?? null,
      customPackageId: selectedPackage && selectedPackage.source !== 'ss_carrier' ? selectedPackage.packageId : null,
      notifyCustomer: false,
      testLabel: isBackendTestOrder(order),
    }

    if (singleActionBusyRef.current) return null
    singleActionBusyRef.current = true
    setSingleActionBusy(true)
    const labelPopup = mode === 'print' ? openLabelPdfPlaceholder() : null
    const schedulePostLabelFollowups = (response: any) => {
      void (async () => {
        try {
          await autoSavePanelSkuDefaults(panelForm.packageId || null, {
            order,
            detail: orderDetail,
            weightOz,
            dims: { length, width, height },
          })
        } catch (error) {
          console.warn('[shopify-label] frontend SKU default save failed:', error instanceof Error ? error.message : error)
        }
        try {
          await refetchOrders()
        } catch (error) {
          console.warn('[shopify-label] frontend refetchOrders failed:', error instanceof Error ? error.message : error)
        }
      })()
      return response
    }

    try {
      if (mode === 'queue') {
        const result = await sendOrdersToQueueBackend([order], {
          kind: 'existing-labels',
          label: 'Queue Shopify Label',
          labelPayloadOverrides: new Map([[order.orderId, payload as Record<string, unknown>]]),
        })
        if (result.queued > 0 && result.skipped === 0 && result.failed === 0) {
          showToast(formatQueuedOrderToast(order.orderNumber ?? order.orderId, getActiveItems(order, orderDetail)), 'success')
        } else if (result.queued > 0 || result.skipped > 0 || result.failed > 0) {
          showToast(formatQueueSendResultToast(result), queueSendToastType(result))
        } else {
          showToast(result.failedErrors[0] ?? result.skippedErrors[0] ?? 'Shopify label was not added to the print queue', 'error')
        }
        return schedulePostLabelFollowups({ orderStatus: 'shipped' })
      }

      const response = await apiClient.createShopifyLabel(payload)
      const queueableLabelUrl = getQueueableLabelUrl(response.labelUrl)
      if (queueableLabelUrl) {
        openLabelPdfUrl(queueableLabelUrl, labelPopup)
        showToast(`Shopify label created${response.trackingNumber ? `: ${response.trackingNumber}` : ''}`, 'success')
      } else if (response.pending) {
        showLabelPdfPlaceholderMessage(
          labelPopup,
          'Shopify label purchase is processing',
          'Shopify has not finished the label purchase yet. Wait a moment, then refresh the order.',
        )
        showToast('Shopify label purchase is still processing', 'info')
      } else {
        showLabelPdfPlaceholderMessage(labelPopup, 'Shopify label created, but no PDF URL returned', 'Try the queue or refresh the order before buying again.')
        showToast(response.labelUrl ? 'Shopify label URL is not queueable' : 'Shopify label created but no PDF returned', response.labelUrl ? 'error' : 'info')
      }
      return schedulePostLabelFollowups(response)
    } catch (error) {
      showLabelPdfPlaceholderMessage(labelPopup, 'Shopify label creation failed', error instanceof Error ? error.message : 'Shopify label creation failed')
      showToast(error instanceof Error ? error.message : 'Shopify label creation failed', 'error')
      return null
    } finally {
      singleActionBusyRef.current = false
      setSingleActionBusy(false)
    }
  }

  async function saveSkuDefaults() {
    if (!panelOrder) return

    const target = getSingleSkuDefaultTarget(panelOrder, panelDetail)
    if (!target) {
      const dims = getPanelDims()
      const ensuredPackageId = hasCompleteDims(dims)
        ? await ensurePanelPackageForDims({ saveSku: false, silent: false })
        : panelForm.packageId
      // PS-121: explicit operator save → recalcGroup so the backend refreshes the same
      // SKU+qty group's stale sibling rates. (The inner handler shows the success/refreshing toast.)
      await savePanelComboDefaults(ensuredPackageId || panelForm.packageId || null, {
        order: panelOrder,
        detail: panelDetail,
        weightOz: getPanelWeightOz(),
        dims: hasCompleteDims(dims) ? dims : null,
        recalcGroup: true,
      })
      return
    }

    const weightOz = getPanelWeightOz()
    const dims = getPanelDims()

    if (!weightOz && !hasCompleteDims(dims)) {
      showToast('Enter weight or complete dims first', 'error')
      return
    }

    try {
      const ensuredPackageId = hasCompleteDims(dims)
        ? await ensurePanelPackageForDims({ saveSku: false, silent: false })
        : panelForm.packageId
      // PS-121: explicit save → recalcGroup. savePanelSkuDefaults (or its combo fall-through)
      // shows the success/refreshing toast + re-polls, so no extra toast here.
      await savePanelSkuDefaults(ensuredPackageId || panelForm.packageId || null, { recalcGroup: true })
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Save failed', 'error')
    }
  }

  // PS-317: the 10 state-bound Best-Rate helpers (carrier-ids, service-options, the request builder,
  // display projections) moved to ./orders/best-rate/rate-helpers (createBestRateHelpers factory,
  // destructured above). orderShippingHold + normalizeDimsLabel moved with them (rate-request / the factory).

  function setAutoBestRateEntry(orderId: number, entry: AutoBestRateEntry) {
    setAutoBestRateEntries((current) => {
      const existing = current[orderId]
      const existingRate = toRecord(existing?.rate)
      if (
        existing?.key === entry.key &&
        toStringValue(existingRate?.matchType) === 'manual'
      ) {
        return current
      }
      return { ...current, [orderId]: entry }
    })
  }

  function setBatchRecalculateRow(orderId: number, row: BatchRecalculateRowState) {
    setBatchRecalculateRows((current) => ({
      ...current,
      [orderId]: row,
    }))
  }

  function withRecalculateTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        const error = new Error('Live rate lookup timed out. Retry this order.')
          ; (error as Error & { code?: string }).code = 'BATCH_RECALCULATE_TIMEOUT'
        reject(error)
      }, timeoutMs)
      promise.then(
        (value) => {
          window.clearTimeout(timeout)
          resolve(value)
        },
        (error) => {
          window.clearTimeout(timeout)
          reject(error)
        },
      )
    })
  }

  function isBatchRecalculateTimeout(error: unknown) {
    return error instanceof Error && (error as Error & { code?: string }).code === 'BATCH_RECALCULATE_TIMEOUT'
  }

  async function applyStrictBestRateResponse(
    order: OrderSummaryDto,
    request: NonNullable<ReturnType<typeof getAutoBestRateRequest>>,
    response: Record<string, unknown> | null | undefined,
    options: {
      updatePanel?: boolean
      refetch?: boolean
    } = {},
  ): Promise<{ status: 'updated' | 'cleared' | 'blocked'; message: string; rate?: Record<string, unknown> | null }> {
    const liveBest = toRecord(response?.bestRate)
    const providerAccountId = liveBest ? toProviderAccountId(liveBest.shippingProviderId) : null
    const serviceCode = liveBest ? toStringValue(liveBest.serviceCode) : null
    // PS-175 / PS-178 final part: the strict apply/blocked/clear decision is
    // BACKEND-owned (response.strictRecalculation) and the backend PERSISTS the
    // outcome inside /browse. The FE's local decision plan and its strict
    // persist calls are DELETED — a response without the verdict (deploy skew)
    // is treated as blocked with an explicit retry message; the FE never
    // decides or writes rate selection.
    const backendStrict = toRecord(response?.strictRecalculation)
    const backendAction = toStringValue(backendStrict?.action)
    const backendMessage = toStringValue(backendStrict?.message)
    const decision = backendAction === 'apply' && liveBest
      ? {
          action: 'apply' as const,
          entry: { key: request.key, rate: liveBest },
          selectedPid: toProviderAccountId(backendStrict?.selectedPid) ?? providerAccountId,
          serviceCode: toStringValue(backendStrict?.serviceCode) ?? serviceCode,
          rate: liveBest,
          message: backendMessage ?? 'Live best rate applied.',
        }
      : backendAction === 'clear'
        ? {
            action: 'clear' as const,
            entry: { key: request.key, rate: null },
            message: backendMessage ?? 'No live rates were returned for this shipment.',
          }
        : {
            action: 'blocked' as const,
            entry: {
              key: request.key,
              rate: null,
              error: backendMessage ?? 'Recalculation did not return a backend verdict — try again.',
            },
            message: backendMessage ?? 'Recalculation did not return a backend verdict — try again.',
          }

    if (decision.action === 'blocked') {
      setAutoBestRateEntries((current) => ({
        ...current,
        [order.orderId]: decision.entry,
      }))
      return { status: 'blocked', message: decision.message }
    }

    // PS-178 final part: the FE strict persist calls are DELETED — the backend
    // persists the outcome inside /browse (dims + best rate + selectedPid, with
    // the same validations). The FE only updates local display state.
    if (decision.action === 'clear') {
      setAutoBestRateEntries((current) => ({
        ...current,
        [order.orderId]: decision.entry,
      }))
      if (options.updatePanel && panelOrderId === order.orderId) {
        setPanelRatePreview([])
      }
      if (options.refetch) await refetchOrders()
      return { status: 'cleared', message: decision.message, rate: null }
    }

    const rateCount = Array.isArray(response?.rates) ? response.rates.length : 1
    const backendRequestFingerprint = getBackendRateResponseFingerprint(response) ?? getBackendRateResponseFingerprint(null, decision.rate)
    const backendComplete = deriveBackendBestRateComplete(response, decision.rate)
    const rateWithMetadata = withRateRequestMetadata(decision.rate, request, {
      isComplete: backendComplete,
      rateCount,
      matchType: 'strict-live',
      cacheCreatedAt: response?.fetchedAt,
      requestFingerprint: backendRequestFingerprint,
      cacheKey: backendRequestFingerprint,
    })
    setAutoBestRateEntries((current) => ({
      ...current,
      [order.orderId]: { key: request.key, rate: rateWithMetadata },
    }))
    if (options.updatePanel && panelOrderId === order.orderId) {
      setPanelForm((current) => {
        const next = {
          ...current,
          shipAccountId: String(decision.selectedPid),
          serviceCode: decision.serviceCode,
        }
        shipmentLastSavedKeyRef.current = getShipmentDetailsKey(order.orderId, next as any)
        return next as any
      })
      setPanelRatePreview([rateWithMetadata])
    }
    if (options.refetch) await refetchOrders()
    return {
      status: 'updated',
      message: 'Best rate recalculated from live carrier responses',
      rate: rateWithMetadata,
    }
  }

  async function runStrictBestRateRecalculation(
    order: OrderSummaryDto,
    request: NonNullable<ReturnType<typeof getAutoBestRateRequest>>,
    options: {
      timeoutMs?: number
      updatePanel?: boolean
      refetch?: boolean
      shouldContinue?: () => boolean
    } = {},
  ): Promise<{ status: 'updated' | 'cleared' | 'blocked'; message: string; rate?: Record<string, unknown> | null }> {
    const browsePromise = apiClient.browseRates({
      weightOz: request.weightOz,
      toZip: request.shipTo.postalCode,
      toCountry: request.shipTo.country ?? 'US',
      toState: request.shipTo.state ?? undefined,
      toCity: request.shipTo.city ?? undefined,
      dimsL: request.dims.length,
      dimsW: request.dims.width,
      dimsH: request.dims.height,
      residential: residentialForRate(order),
      carrierIds: request.carrierIds,
      storeId: order.storeId,
      clientId: order.clientId,
      confirmation: request.confirmation,
      insuranceProvider: request.insuranceProvider,
      insuredValue: request.insuredValue,
      orderId: order.orderId,
      orderNumber: order.orderNumber ?? undefined,
      externalOrderId:
        order.externalOrderId ??
        order.external_order_id ??
        order.orderNumber ??
        undefined,
      forceLive: true,
      forceRefresh: true,
      // PS-083 follow-up: Recalculate must consider the order's visible direct
      // carriers (Walmart Shipping / SHIPP), not just ShipStation - otherwise it
      // overwrites the cheaper direct best rate the Rate Browser found.
      includeVisibleDirectCarriers: true,
      // PS-175: ask the backend for the strict apply/blocked/clear decision —
      // the business rule's owner; the local copy below is a deploy-skew fallback.
      strictRecalculate: true,
    })
    const response = options.timeoutMs
      ? await withRecalculateTimeout(browsePromise, options.timeoutMs)
      : await browsePromise
    if (options.shouldContinue && !options.shouldContinue()) {
      const error = new Error('Recalculate superseded')
        ; (error as Error & { code?: string }).code = 'RECALCULATE_SUPERSEDED'
      throw error
    }

    return applyStrictBestRateResponse(order, request, response, options)
  }

  // PS-286: in-flight applied-rate persists keyed by orderId. The Rate Browser close
  // awaits the relevant one (closeRateBrowserAfterPersist) so the operator can never
  // Send/Print-Queue a row whose just-applied rate hasn't persisted + refetched yet.
  const appliedRatePersistsRef = useRef(new Map<number, Promise<unknown>>())

  async function closeRateBrowserAfterPersist(): Promise<void> {
    // Await EVERY in-flight applied-rate persist (the map auto-clears settled ones),
    // not just the current panel's, so the gate stays correct even when called from a
    // stale closure — e.g. the Escape-key keydown handler captured inside a useEffect.
    await awaitAppliedRatePersists(appliedRatePersistsRef.current, [...appliedRatePersistsRef.current.keys()])
    setRateBrowserOpen(false)
  }

  async function persistAppliedRateForOrder(
    orderId: number,
    rate: Record<string, unknown>,
    options: {
      fallbackDims?: { length: number; width: number; height: number } | null
      fallbackWeightOz?: number | null
      refetch?: boolean
      request?: NonNullable<ReturnType<typeof getAutoBestRateRequest>>
      metadata?: Record<string, unknown>
    } = {},
  ) {
    const dims = getAppliedRateDims(rate) ?? options.fallbackDims ?? null
    const weightOz = getAppliedRateWeightOz(rate) ?? options.fallbackWeightOz ?? null
    if (!hasCompleteDims(dims)) {
      throw new Error('Complete dimensions are required before saving a best rate')
    }
    const dimsLabel = dims ? `${dims.length || 0}x${dims.width || 0}x${dims.height || 0}` : null
    const shippingProviderId = toNumberValue(rate.shippingProviderId)

    const rateToPersist = options.request
      ? withRateRequestMetadata(rate, options.request, options.metadata)
      : rate

    // PS-302: delegate to the backend-owned Apply Best Rate command — ONE atomic persist
    // of dims + weight + selected provider + best_rate_json — instead of the 3 independent
    // browser writes (which could partially fail). The legacy 3-call path remains ONLY as a
    // fallback for the rare no-provider edge (the command requires a selected provider id).
    if (shippingProviderId != null) {
      await apiClient.applyBestRate(orderId, {
        bestRateJson: rateToPersist,
        bestRateDims: dimsLabel,
        selectedPid: shippingProviderId,
        weightOz: weightOz != null && weightOz > 0 ? weightOz : null,
      })
    } else {
      const tasks: Promise<unknown>[] = []
      if (dims || (weightOz != null && weightOz > 0)) {
        tasks.push(apiClient.saveOrderDims(orderId, {
          ...(dims ? { length: dims.length, width: dims.width, height: dims.height } : {}),
          ...(weightOz != null && weightOz > 0 ? { weightOz } : {}),
        }))
      }
      tasks.push(apiClient.saveOrderBestRate(orderId, rateToPersist, dimsLabel))
      await Promise.all(tasks)
    }
    if (options.refetch) {
      await refetchOrders()
      // Per user override unlock shipped data on 2026-06-26: PS-328 only
      // refreshes the active order-detail packageFacts after backend rate
      // persistence; shipped/cancelled locks and read-only gates stay unchanged.
      await queryClient.invalidateQueries({ queryKey: ['v2-hooks:order-detail', orderId] })
    }
  }

  // PS-345: Awaiting Shipment is display-only on mount. Live rate fan-out and
  // bulk backfill now require explicit operator intent (Recalculate All, row Retry,
  // side-panel Recalculate, or the Rate Browser button) so the frontend cannot
  // silently churn carrier jobs or mutate displayed best rates just by loading rows.
  async function refreshPanelBestRate(options: {
    order: OrderSummaryDto
    dims: { length: number; width: number; height: number }
    weightOz: number
    confirmation?: string
    panelForm?: PanelFormState
    silent?: boolean
  }) {
    const { order, dims, weightOz, confirmation, silent = false } = options
    if (!hasCompleteDims(dims) || weightOz <= 0) return null
    const orderDetail = orderDetailsById.get(order.orderId) ?? panelDetail
    const effectivePanelForm = options.panelForm ?? panelForm
    const shippingOptions = buildPanelShippingOptionsPayload(effectivePanelForm)

    if (isTestOrder(order, orderDetail)) {
      const testRate = buildTestMockRate(buildBestTestRateForShipment(order.orderId, dims, weightOz) ?? undefined)
      setPanelRatePreview([testRate])
      setPanelForm((current) => ({
        ...current,
        shipAccountId: TEST_CARRIER_CODE,
        serviceCode: testRate.serviceCode,
      }))
      const autoRequest = getAutoBestRateRequest(order)
      if (autoRequest) {
        setAutoBestRateEntries((current) => ({
          ...current,
          [order.orderId]: { key: autoRequest.key, rate: testRate },
        }))
      }
      await persistAppliedRateForOrder(order.orderId, testRate, {
        fallbackDims: dims,
        fallbackWeightOz: weightOz,
        // Per user override unlock shipped data on 2026-06-26: PS-328 keeps
        // panel Recalculate as a thin refresher of backend packageFacts only.
        refetch: true,
      })
      return testRate
    }

    const shipTo = getShipTo(order, orderDetail)
    if (!shipTo.postalCode) return null

    const runId = bestRateRefreshSeqRef.current + 1
    bestRateRefreshSeqRef.current = runId
    setPanelRateLoading(true)
    setPanelRatePreview([])

    try {
      const carrierIds = getRateCarrierIdsForAccounts()
      const response = await apiClient.browseRates({
        weightOz,
        toZip: shipTo.postalCode,
        toCountry: shipTo.country ?? 'US',
        toState: shipTo.state ?? undefined,
        toCity: shipTo.city ?? undefined,
        dimsL: dims.length,
        dimsW: dims.width,
        dimsH: dims.height,
        residential: residentialForRate(order),
        carrierIds: carrierIds.length ? carrierIds : undefined,
        storeId: order.storeId,
        clientId: order.clientId,
        confirmation: normalizeConfirmationForRates(confirmation ?? shippingOptions.confirmation),
        insuranceProvider: shippingOptions.insuranceProvider,
        insuredValue: shippingOptions.insuredValue,
        orderId: order.orderId,
        orderNumber: order.orderNumber ?? undefined,
        externalOrderId:
          order.externalOrderId ??
          order.external_order_id ??
          order.orderNumber ??
          undefined,
        forceLive: true,
        forceRefresh: true,
        // PS-203 stage 1: the panel refresh compared a ShipStation-only universe
        // and persisted the winner as complete — Shipp/Walmart direct rates never
        // entered the comparison (the $10.44-vs-$9.27 bug). Same flag the
        // explicit Recalculate paths send.
        includeVisibleDirectCarriers: true,
      }) as Record<string, unknown>
      const rates = Array.isArray(response?.rates) ? response.rates as Array<Record<string, unknown>> : []

      if (bestRateRefreshSeqRef.current !== runId) return null

      const bestRate = toRecord(response?.bestRate)
      const dimsLabel = `${dims.length || 0}x${dims.width || 0}x${dims.height || 0}`

      if (bestRate) {
        // PS: `autoRequest` must be declared before metadata/writeback uses it.
        // This keeps panel preview, table sync, and persistAppliedRateForOrder
        // on the same request key.
        const autoRequest = getAutoBestRateRequest(order)
        bestRate.confirmation = shippingOptions.confirmation
        bestRate.insuranceProvider =
          toStringValue(bestRate.effectiveInsuranceProvider) ??
          toStringValue(bestRate.insuranceProvider) ??
          shippingOptions.insuranceProvider
        bestRate.insuredValue =
          toNumberValue(bestRate.effectiveInsuredValue) ??
          toNumberValue(bestRate.insuredValue) ??
          shippingOptions.insuredValue
        const responseFingerprint = getBackendRateResponseFingerprint(response, bestRate)
        const bestRateWithMetadata = autoRequest ? withRateRequestMetadata(bestRate, autoRequest, {
          // PS-135: derive completeness from the backend (its bestRate.isComplete stamp, else
          // carrierStatuses) instead of hardcoding true — a carrier that errors/loads during a
          // panel forceLive fetch must NOT be stamped complete. Matches strict recalc.
          isComplete: deriveBackendBestRateComplete(response, bestRate),
          rateCount: rates.length,
          matchType: 'panel-live',
          requestFingerprint: responseFingerprint,
          cacheKey: responseFingerprint,
          cacheCreatedAt: response?.fetchedAt,
        }) : bestRate
        setPanelRatePreview([bestRateWithMetadata])
        if (autoRequest) {
          setAutoBestRateEntries((current) => ({
            ...current,
            [order.orderId]: { key: autoRequest.key, rate: bestRateWithMetadata },
          }))
        }
        const shippingProviderId = toProviderAccountId((bestRateWithMetadata as any).shippingProviderId)
        const serviceCode = toStringValue((bestRateWithMetadata as any).serviceCode)
        if (shippingProviderId != null && serviceCode) {
          setPanelForm((current) => ({
            ...current,
            shipAccountId: String(shippingProviderId),
            serviceCode,
          }))
          void apiClient.setOrderSelectedPid(order.orderId, shippingProviderId)
        }
        await persistAppliedRateForOrder(order.orderId, bestRateWithMetadata, {
          fallbackDims: dims,
          fallbackWeightOz: weightOz,
          request: autoRequest ?? undefined,
          metadata: autoRequest ? bestRateWithMetadata : undefined,
          // Per user override unlock shipped data on 2026-06-26: PS-328 keeps
          // panel Recalculate as a thin refresher of backend packageFacts only.
          refetch: true,
        })
        return bestRateWithMetadata
      }

      await apiClient.saveOrderBestRate(order.orderId, null, dimsLabel)
      const autoRequest = getAutoBestRateRequest(order)
      if (autoRequest) {
        setAutoBestRateEntries((current) => ({
          ...current,
          [order.orderId]: { key: autoRequest.key, rate: null },
        }))
      }
      setPanelRatePreview([])
      return null
    } catch (error) {
      if (!silent) showToast(error instanceof Error ? error.message : 'Failed to refresh best rate', 'error')
      return null
    } finally {
      if (bestRateRefreshSeqRef.current === runId) setPanelRateLoading(false)
    }
  }

  async function persistShipmentDetails(options: {
    silent?: boolean
    refreshBestRate?: boolean
    skipIfUnchanged?: boolean
  } = {}) {
    if (!panelOrder) return false

    const { silent = false, refreshBestRate = true, skipIfUnchanged = false } = options
    const currentKey = getShipmentDetailsKey(panelOrder.orderId, panelForm)
    if (skipIfUnchanged && currentKey === shipmentLastSavedKeyRef.current) return false

    const weightOz = getPanelWeightOz()
    const dims = getPanelDims()
    const selectedPackage = packages.find((candidate) => getPackageIdentifier(candidate) === panelForm.packageId)
    const dimsToSave = hasCompleteDims(dims) ? dims : getPackageDims(selectedPackage)
    const hasWeightInput = panelForm.weightLb.trim() !== '' || panelForm.weightOz.trim() !== ''
    const hasWeightToSave = hasWeightInput && weightOz > 0

    if (!hasWeightToSave && !dimsToSave && !panelForm.packageId) {
      if (!silent) showToast('Enter weight, size, or package first', 'error')
      return false
    }

    setShipmentDetailsSaving(true)
    try {
      let savedPackageId = panelForm.packageId
      if (hasCompleteDims(dims)) {
        savedPackageId = await ensurePanelPackageForDims({ saveSku: false, silent: true }) || panelForm.packageId
      } else {
        await apiClient.setOrderSelectedPackageId(
          panelOrder.orderId,
          panelForm.packageId ? Number.parseInt(panelForm.packageId, 10) : null,
        )
      }

      const payload: Record<string, number> = {}
      if (dimsToSave) {
        payload.length = dimsToSave.length
        payload.width = dimsToSave.width
        payload.height = dimsToSave.height
      }
      if (hasWeightToSave) payload.weightOz = weightOz

      if (Object.keys(payload).length > 0) {
        await apiClient.saveOrderDims(panelOrder.orderId, payload)
      }

      await autoSavePanelSkuDefaults(savedPackageId || panelForm.packageId || null, {
        order: panelOrder,
        detail: panelDetail,
        weightOz: hasWeightToSave ? weightOz : undefined,
        dims: dimsToSave,
      })

      if (savedPackageId && savedPackageId !== panelForm.packageId) {
        setPanelForm((current) => ({ ...current, packageId: savedPackageId }))
      }

      shipmentLastSavedKeyRef.current = getShipmentDetailsKey(panelOrder.orderId, {
        ...panelForm,
        packageId: savedPackageId || panelForm.packageId,
      })

      if (refreshBestRate && dimsToSave && hasWeightToSave) {
        await refreshPanelBestRate({ order: panelOrder, dims: dimsToSave, weightOz, silent })
      }

      await refetchOrders()
      if (!silent) showToast('Shipment details saved', 'success')
      return true
    } catch (error) {
      if (!silent) showToast(error instanceof Error ? error.message : 'Failed to save shipment details', 'error')
      return false
    } finally {
      setShipmentDetailsSaving(false)
    }
  }

  async function saveShipmentDetails() {
    await persistShipmentDetails({ silent: false, refreshBestRate: true })
  }

  async function toggleResidential() {
    if (!panelOrder) return
    const next = panelOrder.residential == null ? true : panelOrder.residential ? false : null

    try {
      await apiClient.setOrderResidential(panelOrder.orderId, next)
      await refetchOrders()
      showToast('Address type updated', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to update address type', 'error')
    }
  }

  async function markOrderShippedExternal(source: string) {
    if (!panelOrder || extShipBusy) return

    setExtShipBusy(true)
    const trimmedTracking = extShipTracking.trim()
    const wantNotify = extShipNotifyCustomer || extShipNotifyMarketplace
    const channels: string[] = []
    if (extShipNotifyCustomer) channels.push('customer')
    if (extShipNotifyMarketplace) channels.push('marketplace')

    // apiClient.markOrderShippedExternal is wrapped by safe() — it
    // CATCHES errors and returns { ok: false } instead of re-throwing.
    // So a try/catch here cannot detect failure; we must inspect the
    // result shape: success → { data, notify }, failure → { ok: false }.
    // The previous version showed a green '✅ Marked shipped' toast
    // even when the API call failed because the catch block never fired.
    const result = (await apiClient.markOrderShippedExternal(panelOrder.orderId, source, {
      trackingNumber: trimmedTracking || null,
      carrierCode: null, // future: dropdown for carrier when notify is on
      notifyCustomer: extShipNotifyCustomer,
      notifyMarketplace: extShipNotifyMarketplace,
    })) as
      | { data: unknown; notify?: { ok: boolean; reason?: string } }
      | { ok: false }

    setExtShipBusy(false)

    // Detect API-level failure first — if the local DB flip didn't
    // happen, no point continuing to talk about notify status.
    const apiCallFailed = (result as { ok?: unknown })?.ok === false
    if (apiCallFailed) {
      showToast(`❌ Failed to mark shipped via ${source} — check Render logs`, 'error')
      return
    }

    // Local flip succeeded. Now inspect notify status to compose the
    // toast. Three outcomes:
    //   1. Didn't request notify → simple success toast
    //   2. Requested notify, succeeded → success with channel list
    //   3. Requested notify, failed → warning with reason (local DB
    //      already flipped — operator can retry the notify side
    //      separately if needed)
    let summary = `✅ Marked shipped via ${source}`
    let tone: 'success' | 'error' = 'success'
    if (wantNotify) {
      const notify = (result as { notify?: { ok: boolean; reason?: string } }).notify
      if (notify?.ok === true) {
        summary += ` · notified ${channels.join(' + ')}`
      } else {
        summary += ` · ⚠ notify ${channels.join(' + ')} failed: ${notify?.reason ?? 'unknown'}`
        tone = 'error'
      }
    }
    showToast(summary, tone)

    // Reset the popover form so the next open starts fresh — except
    // the marketplace toggle which we keep at "on" for next time.
    setExtShipTracking('')
    setExtShipNotifyCustomer(false)
    setExtShipNotifyMarketplace(true)
    clearSelection()
    await refetchOrders()
  }

  async function reprintLabel() {
    if (!panelOrder) return

    const labelPopup = openLabelPdfPlaceholder()
    try {
      const data = await apiClient.retrieveLabel(panelOrder.orderId)
      // 2026-05-14: was `window.open(data.labelUrl, ...)` directly,
      // which dropped the Supabase Bearer token and silently 401'd
      // on any auth-gated label URL — Chrome's download manager
      // surfaces 401 as "Check internet connection" (boss-reported).
      // Now routed through apiClient.openLabelPdf which proxies via
      // blob: URL when needed.
      const opened = await apiClient.openLabelPdf(data.labelUrl, { popup: labelPopup })
      if (!opened) {
        showLabelPdfPlaceholderMessage(labelPopup, 'Could not open label PDF', 'PrepShip found the label, but the browser could not open it. Allow popups for PrepShip or try Reprint Label again.')
      }
      if (opened) {
        showToast(`📄 Label opened for ${data.trackingNumber || panelOrder.orderNumber || panelOrder.orderId}`)
      } else {
        showToast('Label fetch failed — check the popup tab for details, or try Reprint again.', 'error')
      }
    } catch (error) {
      showLabelPdfPlaceholderMessage(labelPopup, 'Could not retrieve label', error instanceof Error ? error.message : 'Failed to retrieve label')
      showToast(error instanceof Error ? error.message : 'Failed to retrieve label', 'error')
    }
  }

  // PS-219 (per user override unlock shipped data on 2026-06-13): operator Void
  // Label workflow. openVoidConfirm only OPENS the confirm dialog; the void runs
  // in confirmVoidLabel after explicit confirmation. The UI passes ONLY the
  // backend-stamped local shipment id (panelDetail.labelVoidability.shipmentId) —
  // never an order id or a provider/ShipStation id. No optimistic local void:
  // the row leaves Shipped only after a 200 success refetch.
  function openVoidConfirm() {
    if (!panelOrder) return
    const v = (panelDetail as Record<string, unknown> | null)?.labelVoidability as
      | { shipmentId: number | null; voidable: boolean; providerLabel: unknown }
      | null
      | undefined
    if (!v || v.shipmentId == null || !v.voidable) return
    setVoidConfirm({ shipmentId: v.shipmentId, voidability: v, order: panelOrder })
  }

  async function confirmVoidLabel() {
    if (!voidConfirm) return
    setVoidBusy(true)
    try {
      const result = await apiClient.voidLabel(voidConfirm.shipmentId)
      const label = voidConfirm.order.orderNumber ?? voidConfirm.order.orderId
      showToast(
        result?.note || result?.message || `Label voided for ${label}${result?.refundEstimate ? ` — ${result.refundEstimate}` : ''}`,
        'success',
      )
      setVoidConfirm(null)
      // Backend reset the order to awaiting_shipment after provider success;
      // recompute voidability + move the row out of Shipped.
      void queryClient.invalidateQueries({ queryKey: ['v2-hooks:order-detail', voidConfirm.order.orderId] })
      await refetchOrders()
    } catch (error) {
      // Branch on HTTP status (the route maps 409 not_supported/not_voidable,
      // 502 provider_failed, 404 not-found) — never on message text. No local
      // change on failure: the shipment stays visible/active.
      const status = (error as { status?: number } | null)?.status
      const message =
        status === 409
          ? 'This label can’t be voided from PrepShip — void it at the carrier portal. The label stays active.'
          : status === 502
            // Per user override unlock shipped data on 2026-07-06 (PS-399): show
            // the backend-sanitized provider detail while leaving the label active.
            ? (error instanceof Error ? error.message : 'Provider void failed — the label is still active. Try again in a moment.')
            : status === 404
              ? 'Shipment not found — refresh the order and try again.'
              : error instanceof Error ? error.message : 'Void failed'
      showToast(message, 'error')
      setVoidConfirm(null)
    } finally {
      setVoidBusy(false)
    }
  }

  function isExistingLabelCreateConflict(error: unknown) {
    // PS-190: conflict detection is code-based — the backend stamps
    // LABEL_EXISTS (active label already on the order) or ORDER_NOT_EDITABLE
    // (shipped/cancelled) and the api transport carries it as
    // error.code. No substring-matching of human messages.
    const code = (error as { code?: unknown } | null)?.code
    return code === 'LABEL_EXISTS' || code === 'ORDER_NOT_EDITABLE'
  }

  async function queueExistingLabelAfterCreateConflict(order: OrderSummaryDto, error: unknown) {
    if (!isExistingLabelCreateConflict(error)) return false

    // Per user override unlock shipped data on 2026-05-23: read the existing
    // shipped label and queue it; do not create new postage for shipped rows.
    const data = await apiClient.retrieveLabel(order.orderId, true)
    const queueableLabelUrl = getQueueableLabelUrl(data.labelUrl)
    if (!queueableLabelUrl) {
      throw new Error('Existing label URL is not queueable - reprint the label and try again.')
    }
    if (order.clientId == null) {
      throw new Error('Missing client id - existing label was not added to the print queue')
    }

    const result = await apiClient.addToQueue(buildQueueAddPayload(order, queueableLabelUrl))
    if (!result?.queue_entry_id && !result?.already_queued) {
      throw new Error('Existing label was found, but the queue add was not confirmed. Try Print to Queue again.')
    }

    await hydrateQueue(true)
    await refetchOrders()
    showToast(
      `Existing label added to print queue for ${order.orderNumber ?? order.orderId}`,
      'success',
    )
    return true
  }

  async function openRateBrowser() {
    if (!panelOrder) return
    if (isTestOrder(panelOrder, panelDetail)) {
      const weightOz = getPanelWeightOz() || getOrderWeightOz(panelOrder, panelDetail)
      const panelDims = getPanelDims()
      const selectedPackage = packages.find((candidate) => getPackageIdentifier(candidate) === panelForm.packageId)
      const dims = hasCompleteDims(panelDims)
        ? panelDims
        : getPackageDims(selectedPackage) ?? getDimensions(panelOrder, panelDetail)

      if (!weightOz) {
        showToast('Enter shipment weight', 'error')
        return
      }
      if (!dims || !hasCompleteDims(dims)) {
        showToast('Enter shipment size', 'error')
        return
      }

      setRateBrowserRates([buildTestMockRate(buildBestTestRateForShipment(panelOrder.orderId, dims, weightOz) ?? undefined)])
      setRateBrowserLoading(false)
      setRateBrowserOpen(true)
      return
    }

    setRateBrowserOpen(true)
    setRateBrowserRates([])
    setRateBrowserLoading(false)
  }

  async function recalculateBestRate() {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment') return null
    if (isTestOrder(panelOrder, panelDetail)) {
      showToast('Test orders use mock rates and do not need live recalculation')
      return null
    }

    const dims = getPanelDims()
    const weightOz = getPanelWeightOz()
    const shipTo = getShipTo(panelOrder, panelDetail)
    const carrierIds = getRateCarrierIdsForAccounts()

    if (!hasCompleteDims(dims)) {
      showToast('Enter complete shipment size before recalculating', 'error')
      return null
    }
    if (weightOz <= 0) {
      showToast('Enter shipment weight before recalculating', 'error')
      return null
    }
    if (!shipTo.postalCode) {
      showToast('Ship-to postal code is required before recalculating', 'error')
      return null
    }
    if (accountsLoading) {
      showToast('Carrier accounts are still loading. Try Recalculate again in a moment.', 'error')
      return null
    }
    if (carrierIds.length === 0) {
      showToast('No carrier accounts are available for this order scope', 'error')
      return null
    }

    const shippingOptions = buildPanelShippingOptionsPayload(panelForm)
    const confirmation = normalizeConfirmationForRates(shippingOptions.confirmation)
    const dimsLabel = `${dims.length || 0}x${dims.width || 0}x${dims.height || 0}`
    const draftKey = buildRateRequestDraftKey({
      weightOz,
      dims,
      shipTo,
      residential: residentialForRate(panelOrder),
      carrierIds,
      storeId: panelOrder.storeId,
      clientId: panelOrder.clientId,
      confirmation,
      insuranceProvider: shippingOptions.insuranceProvider,
      insuredValue: shippingOptions.insuredValue,
    })
    const request = {
      detail: panelDetail,
      dims,
      dimsLabel,
      weightOz,
      shipTo,
      confirmation,
      carrierIds,
      insuranceProvider: shippingOptions.insuranceProvider,
      insuredValue: shippingOptions.insuredValue,
      draftKey,
      key: `${panelOrder.orderId}|${draftKey}`,
    }

    const runId = bestRateRefreshSeqRef.current + 1
    bestRateRefreshSeqRef.current = runId
    setPanelRateLoading(true)
    setPanelRatePreview([])

    try {
      const result = await runStrictBestRateRecalculation(panelOrder, request, {
        updatePanel: true,
        refetch: true,
        shouldContinue: () => bestRateRefreshSeqRef.current === runId,
      })
      if (bestRateRefreshSeqRef.current !== runId) return null
      showToast(result.message, result.status === 'updated' ? 'success' : 'error')
      return result.rate ?? null
    } catch (error) {
      if (bestRateRefreshSeqRef.current === runId) {
        if (error instanceof Error && (error as Error & { code?: string }).code === 'RECALCULATE_SUPERSEDED') {
          return null
        }
        const message = error instanceof Error ? error.message : 'Failed to recalculate best rate'
        setAutoBestRateEntries((current) => ({
          ...current,
          [panelOrder.orderId]: { key: request.key, rate: null, error: message },
        }))
        showToast(message, 'error')
      }
      return null
    } finally {
      if (bestRateRefreshSeqRef.current === runId) setPanelRateLoading(false)
    }
  }

  function applyRateSelection(rate: Record<string, unknown>) {
    if (panelOrder && isTestOrder(panelOrder, panelDetail)) {
      const testRate = buildTestMockRate(rate)
      const dims = rate?.dims && typeof rate.dims === 'object' ? rate.dims as Record<string, unknown> : null
      const dimsLabel = dims
        ? `${Number(dims.length) || 0}x${Number(dims.width) || 0}x${Number(dims.height) || 0}`
        : `${panelForm.length || 0}x${panelForm.width || 0}x${panelForm.height || 0}`

      setPanelForm((current) => ({
        ...current,
        shipAccountId: TEST_CARRIER_CODE,
        serviceCode: testRate.serviceCode,
      }))
      setPanelRatePreview([testRate])
      trackAppliedRatePersist(
        appliedRatePersistsRef.current,
        panelOrder.orderId,
        Promise.resolve()
          .then(() => apiClient.saveOrderDims(panelOrder.orderId, {
            ...(dims ? { length: Number(dims.length) || 0, width: Number(dims.width) || 0, height: Number(dims.height) || 0 } : {}),
            weightOz: getPanelWeightOz() || getOrderWeightOz(panelOrder, panelDetail),
          }))
          .then(() => apiClient.saveOrderBestRate(panelOrder.orderId, testRate, dimsLabel))
          .then(() => refetchOrders())
          .catch((error) => {
            showToast(error instanceof Error ? error.message : 'Failed to save test mock rate', 'error')
          }),
      )
      void closeRateBrowserAfterPersist()
      return
    }

    const shippingProviderId = toNumberValue(rate.shippingProviderId)
    const serviceCode = toStringValue(rate.serviceCode)
    if (!panelOrderId || shippingProviderId == null || !serviceCode) return

    const autoRequest = panelOrder ? getAutoBestRateRequest(panelOrder) : null
    const appliedRateComplete = rate.isComplete === true
    const appliedRateCount = toNumberValue(rate.rateCount) ?? 1
    const rateForTable = autoRequest
      ? withRateRequestMetadata(rate, autoRequest, {
        isComplete: appliedRateComplete,
        rateCount: appliedRateCount,
        matchType: 'manual',
      })
      : rate

    setPanelForm((current) => ({
      ...current,
      shipAccountId: String(shippingProviderId),
      serviceCode,
    }))
    setPanelRatePreview([rateForTable])
    if (autoRequest) {
      setAutoBestRateEntries((current) => ({
        ...current,
        [panelOrderId]: { key: autoRequest.key, rate: rateForTable },
      }))
    }
    trackAppliedRatePersist(
      appliedRatePersistsRef.current,
      panelOrderId ?? 0,
      Promise.resolve()
        .then(() => persistAppliedRateForOrder(panelOrderId ?? 0, rate, {
          fallbackDims: getPanelDims(),
          fallbackWeightOz: getPanelWeightOz() || getOrderWeightOz(panelOrder, panelDetail),
          ...(autoRequest
            ? {
              request: autoRequest,
              metadata: { isComplete: appliedRateComplete, rateCount: appliedRateCount, matchType: 'manual' },
            }
            : {}),
          refetch: true,
        }))
        .catch((error) => {
        showToast(error instanceof Error ? error.message : 'Failed to save selected rate', 'error')
      }),
    )
    void closeRateBrowserAfterPersist()
  }

  async function printPicklist() {
    try {
      const data: OrderPicklistResponseDto = await apiClient.fetchPicklist({
        orderStatus: currentStatus,
        storeId: activeStore ?? undefined,
        dateStart: dateRange.start,
        dateEnd: dateRange.end,
      } as any)
      if (!data.skus.length) {
        showToast('No items found for current filter')
        return
      }

      const dateLabel = dateFilter === 'custom' && dateRange.start
        ? `${dateRange.start}${dateRange.end ? ` – ${dateRange.end}` : ''}`
        : dateFilter || 'all dates'
      const html = buildPicklistPrintHtml(data.skus, {
        generatedAt: new Date().toLocaleString('en-US', { timeZone: CALIFORNIA_TZ }),
        dateLabel,
        statusLabel: currentStatus.replace(/_/g, ' '),
      })
      const printWindow = window.open('', '_blank')
      if (!printWindow) {
        showToast('Allow popups to print pick list', 'error')
        return
      }
      printWindow.document.write(html)
      printWindow.document.close()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Picklist error', 'error')
    }
  }

  function escapePrintWindowText(message: string) {
    return message.replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[char] ?? char))
  }

  function openQueuePrintWindow() {
    const printWindow = window.open('', '_blank')
    if (!printWindow) return null
    printWindow.document.write(`<!doctype html>
<html>
  <head>
    <title>PrepShip Print Queue</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fb; color: #172033; }
      main { text-align: center; max-width: 360px; padding: 32px; }
      .spinner { width: 30px; height: 30px; border: 3px solid #d8e0ef; border-top-color: #2563eb; border-radius: 50%; margin: 0 auto 16px; animation: spin 1s linear infinite; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { font-size: 13px; color: #5b667a; margin: 0; line-height: 1.45; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      <div class="spinner"></div>
      <h1>Preparing PDF</h1>
      <p>Your labels are being merged. This tab will show the PDF when it is ready.</p>
    </main>
  </body>
</html>`)
    printWindow.document.close()
    return printWindow
  }

  function showQueuePrintWindowError(printWindow: Window | null, message: string) {
    if (!printWindow || printWindow.closed) return
    printWindow.document.open()
    printWindow.document.write(`<!doctype html>
<html>
  <head><title>PrepShip Print Queue</title></head>
  <body style="font-family: Arial, sans-serif; padding: 32px; color: #172033;">
    <h1 style="font-size: 18px;">PDF failed</h1>
    <p style="font-size: 13px; color: #5b667a;">${escapePrintWindowText(message)}</p>
  </body>
</html>`)
    printWindow.document.close()
  }

  async function printQueueEntries(entryIds: string[], options: { printWindow?: Window | null } = {}) {
    if (entryIds.length === 0) return false

    // Batch-print pipeline: the create-print chain opens its window at click time
    // (popup-blocker safety) and hands it in; drawer callers keep the old behavior.
    const printWindow = options.printWindow ?? openQueuePrintWindow()
    let pdfOpened = false
    // PS-194: which entries ACTUALLY merged is backend truth
    // (successful_entry_ids on the job DTO) — a held/failed label must not be
    // marked print-ready just because it was requested. Falls back to the
    // requested ids only when an older backend omits the field.
    let mergedEntryIds: string[] = entryIds
    setQueuePrintInFlight(true)
    setQueuePrintProgress(0)
    setQueuePrintMessage('Starting merge…')
    try {
      const job = await apiClient.startQueuePrintJob(queueClientId, entryIds, true)
      if (!job?.job_id) {
        throw new Error('Print job did not start')
      }

      let done = false
      while (!done) {
        await new Promise((resolve) => window.setTimeout(resolve, 600))
        const status = await apiClient.fetchQueuePrintJobStatus(job.job_id)
        if (!status || status.status === 'unknown') {
          throw new Error('Print job status unavailable')
        }
        setQueuePrintMessage(status.message)
        setQueuePrintProgress(typeof status.progress === 'number' ? status.progress : null)

        if (status.status === 'done') {
          const backendMergedIds = Array.isArray(status.successful_entry_ids)
            ? (status.successful_entry_ids as unknown[]).filter((id): id is string => typeof id === 'string')
            : null
          if (backendMergedIds) mergedEntryIds = backendMergedIds
          // The signed PDF URL is short-lived but stable enough for Chrome's
          // native PDF viewer save/download controls; do not use a blob URL
          // here because the old 30s revoke window made viewer downloads fail.
          try {
            const opened = await apiClient.openQueuePrintJobPdf(job.job_id, {
              popup: printWindow,
              disposition: 'inline',
            })
            pdfOpened = opened
            if (!opened) {
              const signed = await apiClient.fetchQueuePrintJobSignedUrl(job.job_id, 'attachment')
              const firstChunk = Array.isArray(signed.chunks)
                ? signed.chunks.find((chunk) => chunk.status === 'done' && typeof chunk.url === 'string' && chunk.url)
                : null
              const link = document.createElement('a')
              link.href = firstChunk?.url || signed.url
              link.download = firstChunk?.file_name || signed.filename || `prepship-labels-${job.job_id}.pdf`
              document.body.appendChild(link)
              link.click()
              document.body.removeChild(link)
              pdfOpened = true
            }
          } catch (err) {
            console.error('[print-queue] download failed', err)
          }
          done = true
          setQueuePrintProgress(100)
        }
        if (status.status === 'error') {
          throw new Error(status.error || status.errorMessage || 'PDF merge failed')
        }
      }

      await hydrateQueue()
      if (pdfOpened) {
        setQueuePrintReadyEntryIds((current) => {
          const next = new Set(current)
          mergedEntryIds.forEach((entryId) => next.add(entryId))
          return next
        })
      }
      showToast(
        pdfOpened
          ? `✅ ${entryIds.length} label${entryIds.length === 1 ? '' : 's'} — opened in new tab`
          : `✅ ${entryIds.length} label${entryIds.length === 1 ? '' : 's'} — PDF ready, but popup was blocked`,
        pdfOpened ? 'success' : 'error'
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Print failed'
      showQueuePrintWindowError(printWindow, message)
      showToast(message, 'error')
    } finally {
      setQueuePrintInFlight(false)
      setQueuePrintMessage(null)
      setQueuePrintProgress(null)
    }
    return pdfOpened
  }

  async function confirmQueueEntriesPrinted(entryIds: string[]) {
    if (entryIds.length === 0) return
    const notPrintedCount = entryIds.filter((entryId) => !queuePrintReadyEntryIds.has(entryId)).length
    if (notPrintedCount > 0) {
      window.alert(
        `${notPrintedCount} queued label${notPrintedCount === 1 ? '' : 's'} not printed yet. Click Print All first, then confirm printed after the PDF opens.`
      )
      return
    }
    const ok = window.confirm(
      `Confirm ${entryIds.length} label${entryIds.length === 1 ? '' : 's'} printed successfully? This removes them from the active Print Queue.`
    )
    if (!ok) return
    try {
      const result = await apiClient.confirmPrintedQueueEntries(queueClientId, entryIds)
      await hydrateQueue()
      setQueuePrintReadyEntryIds((current) => {
        const next = new Set(current)
        entryIds.forEach((entryId) => next.delete(entryId))
        return next
      })
      const count = result?.confirmed_count ?? entryIds.length
      showToast(`Confirmed ${count} printed label${count === 1 ? '' : 's'}`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to confirm printed labels', 'error')
    }
  }

  async function handleAssignSelectedOrders() {
    if (!callerIsAdmin) {
      showToast('Only admins can assign orders', 'error')
      return
    }
    const ids = [...selectedIdSet]
    if (ids.length === 0) {
      showToast('No orders selected', 'error')
      return
    }
    if (!assignTo) {
      showToast('Pick a user (or "Unassign") first', 'error')
      return
    }

    const target = assignTo === 'unassign'
      ? { userId: null, email: null, label: 'Unassigned' }
      : (() => {
        const u = assignableUsers.find((cand) => cand.id === assignTo)
        return u ? { userId: u.id, email: u.email, label: u.email } : null
      })()
    if (!target) {
      showToast('User not found in list — refresh the page', 'error')
      return
    }

    setAssignBusy(true)
    try {
      const res = await api.post<{ updated: number; requested: number }>(
        '/orders/bulk-assign',
        { orderIds: ids, userId: target.userId, email: target.email },
      )
      showToast(`Assigned ${res.updated}/${res.requested} order(s) to ${target.label}`, 'success')
      clearSelection()
      await refetchOrders()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to assign orders', 'error')
    } finally {
      setAssignBusy(false)
    }
  }

  // PS-312/PS-317 (S4): thin no-arg adapter the batch panel calls; the action logic + busy state live
  // in useCombineShipments (wired above with the toast + post-combine refresh).
  function handleCombineShipments() {
    void combineShipments(selectedOrderIds)
  }

  // Batch-print pipeline: the same 30s fade + refetch the legacy print loop runs
  // per bought row (boss directive 2026-05-07 — the operator must SEE the order
  // fading). The legacy block below stays byte-identical this ship; this helper is
  // consumed only by the flag-ON chain and by the follow-up that deletes the loop.
  function beginShippedFadeTransition(orderId: number) {
    const TRANSITION_MS = 30_000
    setTransitionalShippedIds((prev) => {
      const next = new Set(prev)
      next.add(orderId)
      return next
    })
    const existing = transitionalTimeoutsRef.current.get(orderId)
    if (existing) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      setTransitionalShippedIds((prev) => {
        const next = new Set(prev)
        next.delete(orderId)
        return next
      })
      transitionalTimeoutsRef.current.delete(orderId)
      scheduleOrdersRefetch(250)
    }, TRANSITION_MS)
    transitionalTimeoutsRef.current.set(orderId, timer)
  }

  async function handleBatchAction(mode: 'print' | 'queue') {
    let batchOrders: OrderSummaryDto[] = []
    try {
      batchOrders = await hydrateSelectedOrdersForActions()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to load selected orders', 'error')
      return
    }
    if (batchOrders.length === 0) {
      showToast('No orders selected', 'error')
      return
    }
    if (hasShopifyLabelPurchaseIntent(batchOrders) && !window.confirm(SHOPIFY_LABEL_PURCHASE_CONFIRM_MESSAGE)) {
      showToast('Shopify label purchase cancelled', 'info')
      return
    }

    if (mode === 'queue') {
      setBatchBusy(true)
      try {
        const result = await sendOrdersToQueueBackend(batchOrders, {
          kind: 'batch-queue',
          label: 'Sending to queue',
          batchTestMode,
        })
        if (result.queued > 0 || result.skipped > 0 || result.failed > 0) {
          showToast(formatQueueSendResultToast(result), queueSendToastType(result))
        } else {
          showToast(result.skippedErrors[0] ?? result.failedErrors[0] ?? 'No orders added to queue', 'error')
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Failed to send to queue', 'error')
      } finally {
        setBatchBusy(false)
        clearSelection()
      }
      return
    }

    if (mode === 'print') {
      // Batch-print pipeline: Create + Print chains the two existing backend jobs —
      // /print-queue/batch-send buys (≤8 concurrent, durable, createLabelV2 gate
      // ladder, LABEL_EXISTS recovery) and /print-queue/print merges ONE
      // 4×6-normalized PDF. The FE buys nothing here. (The legacy sequential
      // per-order loop was deleted 2026-07-07 after the live canary — the
      // BATCH_PRINT_VIA_QUEUE rollout flag went with it; rollback = git revert.)
      const printWindow = openQueuePrintWindow()
      setBatchBusy(true)
      try {
        const outcome = await runCreatePrintChain(batchOrders, {
          needsOverride: (order) =>
            !isBackendTestOrder(order) &&
            !buildSelectedRateProofPayload(
              order,
              order.bestRate ?? order.selectedRate,
              resolveOrderShippingProviderId(order),
            ),
          recalculate: async (order) => {
            const request = getAutoBestRateRequest(order)
            if (!request) return { ok: false as const, message: 'Recalculate current best rate before label purchase' }
            const result = await runStrictBestRateRecalculation(order, request, {
              timeoutMs: BATCH_RECALCULATE_TIMEOUT_MS,
            })
            if (result.status !== 'updated' || !result.rate) {
              return { ok: false as const, message: result.message || 'Current best rate could not be proven before label purchase' }
            }
            return { ok: true as const, rate: result.rate }
          },
          buildOverride: (order, freshRate) => buildBatchPrintOverridePayload(order, freshRate),
          runPool: (poolOrders, worker) => runWithConcurrency(poolOrders, BATCH_QUEUE_CONCURRENCY, worker),
          sendToQueue: (sendableOrders, overrides) =>
            sendOrdersToQueueBackend(sendableOrders, {
              kind: 'create-print',
              label: 'Creating labels',
              batchTestMode,
              labelPayloadOverrides: overrides,
              deferOrdersRefetch: true,
            }),
          printEntries: (entryIds) => printQueueEntries(entryIds, { printWindow }),
          markShipped: (orderId) => beginShippedFadeTransition(orderId),
        })
        if (!outcome.printAttempted) printWindow?.close()
        if (outcome.queued > 0) {
          const failSuffix = outcome.failed > 0
            ? ` — ${outcome.errors.slice(0, 3).join('; ')}${outcome.errors.length > 3 ? ` (+${outcome.errors.length - 3} more)` : ''}`
            : ''
          showToast(
            `✅ Created ${outcome.queued} label${outcome.queued === 1 ? '' : 's'} — ${outcome.printed ? 'merged PDF opened' : 'PDF ready in the Print Queue drawer'}${failSuffix}`,
            outcome.failed > 0 ? undefined : 'success',
          )
        } else {
          showToast(outcome.errors[0] ?? 'No labels were created', 'error')
        }
      } catch (error) {
        printWindow?.close()
        showToast(error instanceof Error ? error.message : 'Create + Print failed', 'error')
      } finally {
        setBatchBusy(false)
        clearSelection()
      }
      return
    }

  }

  // Batch Mark-as-Shipped — flips externallyShipped=true on every
  // selected order in one go, optionally pushing notify-customer +
  // notify-marketplace through to ShipStation v1 markasshipped for
  // each. Mirrors the single-order popover (state lives in a parallel
  // set of useState hooks below) so behavior is consistent: same
  // toggles, same source picker, same per-order failure handling.
  //
  // We process orders sequentially (not Promise.all) for two reasons:
  //   1. The /shipped-external endpoint runs ssMarkOrderShippedV1
  //      under the hood, which hits ShipStation's rate-limited v1 API.
  //      Parallel calls trigger 429s.
  //   2. Surfacing partial-failure stats ('5 ok, 2 failed') is much
  //      cleaner with a sequential loop + ok/failed counters.
  //
  // CRITICAL detail on error detection:
  //   apiClient.markOrderShippedExternal is wrapped by safe() which
  //   catches any thrown error and returns the fallback { ok: false }
  //   instead of re-throwing. That means a try/catch around the call
  //   would NEVER fire — every iteration would land in the success
  //   branch even when the backend 500'd. We instead inspect the
  //   returned shape: success → { data, notify }; failure → { ok: false }.
  //   Detecting result?.ok === false is the only reliable way to count
  //   failures correctly.
  async function handleBatchMarkAsShipped(source: string) {
    let batchOrders: OrderSummaryDto[] = []
    try {
      batchOrders = await hydrateSelectedOrdersForActions()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to load selected orders', 'error')
      return
    }
    if (batchOrders.length === 0) {
      showToast('No orders selected', 'error')
      return
    }
    if (extShipBusy) return
    setExtShipBusy(true)
    showToast(`📦 Marking ${batchOrders.length} order${batchOrders.length === 1 ? '' : 's'} shipped via ${source}…`)

    let ok = 0
    let failed = 0
    let notifyOk = 0
    let notifyFailed = 0
    const failureReasons: string[] = []
    const notifyChannels: string[] = []
    if (extShipNotifyCustomer) notifyChannels.push('customer')
    if (extShipNotifyMarketplace) notifyChannels.push('marketplace')
    const wantNotify = notifyChannels.length > 0

    for (const order of batchOrders) {
      // Note the explicit unknown-cast: the apiClient method returns
      // any (legacy v2-compat type), which would let bugs through
      // without typecheck noticing. Forcing inspection through a
      // narrowed local removes the any-blob.
      const result = (await apiClient.markOrderShippedExternal(order.orderId, source, {
        trackingNumber: null,
        carrierCode: null,
        notifyCustomer: extShipNotifyCustomer,
        notifyMarketplace: extShipNotifyMarketplace,
      })) as
        | { data: unknown; notify?: { ok: boolean; reason?: string } }
        | { ok: false }

      // safe() returns { ok: false } on any thrown error. The successful
      // backend response is shaped { data: row, notify: {...} } and
      // never has an `ok` field at the top level. So an `ok === false`
      // means the API call itself failed (network, 5xx, validation).
      const apiCallFailed = (result as { ok?: unknown })?.ok === false
      if (apiCallFailed) {
        failed += 1
        failureReasons.push(`#${order.orderNumber ?? order.orderId}`)
        console.warn(`[batch mark-shipped] order ${order.orderId} api call failed`)
        continue
      }

      ok += 1

      // Notify result is per-order. The local DB flip already succeeded
      // (because we got `data` back). The optional ShipStation v1 call
      // may have failed independently — track that separately so a
      // 'marked locally but not notified' partial state surfaces in
      // the toast instead of being silently swallowed.
      if (wantNotify) {
        const notify = (result as { notify?: { ok: boolean; reason?: string } }).notify
        if (notify?.ok === true) {
          notifyOk += 1
        } else {
          notifyFailed += 1
          if (notify?.reason) {
            console.warn(`[batch mark-shipped] order ${order.orderId} notify failed: ${notify.reason}`)
          }
        }
      }
    }

    setExtShipBusy(false)
    clearSelection()
    await refetchOrders()

    // Compose summary toast — explicit about THREE outcomes:
    //   1. Local DB flip count (ok/total)
    //   2. Notify success count (when notify was requested)
    //   3. Failure breakdown (with order numbers if 1-3 failed)
    const tone: 'success' | 'error' = failed > 0 ? 'error' : 'success'
    let summary = `${failed === 0 ? '✅' : '⚠'} Marked ${ok}/${batchOrders.length} shipped via ${source}`
    if (wantNotify) {
      if (notifyFailed === 0) {
        summary += ` · notified ${notifyChannels.join(' + ')}`
      } else {
        summary += ` · notified ${notifyOk}/${ok} (${notifyFailed} notify failed)`
      }
    }
    if (failed > 0) {
      const sample = failureReasons.slice(0, 3).join(', ')
      const more = failureReasons.length > 3 ? ` +${failureReasons.length - 3} more` : ''
      summary += ` · failures: ${sample}${more}`
    }
    showToast(summary, tone)

    // Reset popover form for the next batch.
    setExtShipNotifyCustomer(false)
    setExtShipNotifyMarketplace(true)
    setBatchExtShipMenuOpen(false)
  }

  async function resumePersistentQueueJob(job: PersistentQueueJob) {
    if (resumePersistentQueueJobIdRef.current === job.id) return

    const completedOrFailed = new Set([...(job.completedOrderIds ?? []), ...(job.failedOrderIds ?? [])])
    const pendingOrders = (job.orders ?? []).filter((order) => order?.orderId != null && !completedOrFailed.has(order.orderId))
    const progress = getPersistentQueueJobProgress(job)

    if (job.backendJobId) {
      resumePersistentQueueJobIdRef.current = job.id
      activePersistentQueueJobIdRef.current = job.id
      startQueueActionProgress(progress.total, 'Resuming queue', progress.completed, progress.failed)
      showToast(`Resuming queue send (${progress.completed}/${progress.total})`)
      try {
        const status = await pollBackendQueueSendJob(job.backendJobId, progress.total)
        await refreshQueueAfterBackendStatus(status)
        await refetchOrders()
        const queued = toNumberValue(status?.queued) ?? 0
        const skipped = toNumberValue(status?.skipped) ?? 0
        const failed = toNumberValue(status?.failed) ?? 0
        showToast(
          queued > 0 || skipped > 0 || failed > 0
            ? `Queue updated: ${queued} queued${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`
            : 'Queue checked',
          failed > 0 ? 'error' : skipped > 0 ? 'info' : queued > 0 ? 'success' : 'info',
        )
        finishQueueActionProgress(queued > 0 ? 'Queue updated' : 'Queue checked')
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Failed to resume queue send', 'error')
        finishQueueActionProgress('Queue resume failed')
      } finally {
        clearPersistentQueueJob(job.id)
        activePersistentQueueJobIdRef.current = null
        resumePersistentQueueJobIdRef.current = null
      }
      return
    }

    if (pendingOrders.length === 0) {
      clearPersistentQueueJob(job.id)
      return
    }

    // PS-176 part 2: localStorage holds IDENTIFIERS ONLY — never money payloads.
    // A batch-queue job interrupted BEFORE its backend job id was recorded must
    // NOT re-buy labels from local state: hand control back to the operator
    // (fresh selection → fresh backend job with live data + full validation).
    if (job.kind === 'batch-queue') {
      clearPersistentQueueJob(job.id)
      showToast(
        `Queue send was interrupted — ${pendingOrders.length} order${pendingOrders.length === 1 ? ' was' : 's were'} not sent. Select them and Print to Queue again.`,
        'error',
      )
      return
    }

    resumePersistentQueueJobIdRef.current = job.id
    activePersistentQueueJobIdRef.current = job.id
    startQueueActionProgress(progress.total, 'Resuming queue', progress.completed, progress.failed)
    showToast(`Resuming queue send (${progress.completed}/${progress.total})`)

    let sent = 0
    let failed = 0

    const markAndAdvance = (ref: PersistentQueueOrderRef, orderFailed: boolean) => {
      markPersistentQueueJobOrder(job.id, ref.orderId, orderFailed)
      advanceQueueActionProgress(orderFailed ? 1 : 0)
    }

    // existing-labels resume: queue the EXISTING label (no postage). Everything
    // is re-read FRESH — the label URL from the backend, the queue payload from
    // the current page's live order DTO when available.
    const processExistingLabelRef = async (ref: PersistentQueueOrderRef) => {
      if (ref.clientId == null) {
        failed += 1
        markAndAdvance(ref, true)
        return
      }
      try {
        const labelData = await apiClient.retrieveLabel(ref.orderId, true)
        const labelUrl = getQueueableLabelUrl(labelData?.labelUrl)
        if (!labelUrl) throw new Error('no queueable label')
        const freshOrder = orderedFilteredOrders.find((candidate) => candidate.orderId === ref.orderId)
        const payload = freshOrder
          ? buildQueueAddPayload(freshOrder, labelUrl)
          : {
              client_id: ref.clientId,
              order_id: String(ref.orderId),
              order_number: ref.orderNumber ?? null,
              label_url: labelUrl,
              sku_group_id: `order-${ref.orderId}`,
              order_qty: 1,
            }
        await apiClient.addToQueue(payload)
        sent += 1
        markAndAdvance(ref, false)
      } catch {
        failed += 1
        markAndAdvance(ref, true)
      }
    }

    try {
      setQueueLoading(true)
      await runWithConcurrency(pendingOrders, BATCH_QUEUE_CONCURRENCY, processExistingLabelRef)
      setQueueLoading(false)

      if (sent > 0) {
        setQueueActionProgressLabel('Refreshing queue')
        setQueueLoading(true)
        try {
          const payload = await apiClient.fetchQueue(queueClientId, queueHistoryVisible)
          setQueueEntries(getQueuePayloadEntries(payload))
          setQueueEntriesClientId(queueClientId)
          setQueueOpen(true)
        } finally {
          setQueueLoading(false)
        }
      }

      await refetchOrders()
      if (sent > 0) {
        showToast(`✓ ${sent} existing label${sent === 1 ? '' : 's'} re-queued${failed ? `, ${failed} failed` : ''}`, 'success')
      } else {
        showToast('⚠ Queue resume finished with no new orders added')
      }
    } finally {
      setQueueLoading(false)
      setBatchBusy(false)
      finishPersistentQueueJob(job.id)
      resumePersistentQueueJobIdRef.current = null
      finishQueueActionProgress(sent > 0 ? 'Queue updated' : 'Queue checked')
    }
  }

  useEffect(() => {
    if (loading) return
    const job = readPersistentQueueJob()
    if (!job) return
    if (resumePersistentQueueJobIdRef.current === job.id || activePersistentQueueJobIdRef.current === job.id) return

    void resumePersistentQueueJob(job)
  }, [loading])

  const toggleSort = (key: SortKey) => {
    setPreSkuSortSnapshot(null)
    setSkuSortActive(false)
    setSortState((current) => {
      if (current.key === key) {
        return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      }

      return {
        key,
        dir: key === 'date' || key === 'age' ? 'desc' : 'asc',
      }
    })
  }

  const toggleSkuSort = () => {
    if (!skuSortActive) {
      setPreSkuSortSnapshot(orderedFilteredOrders.map((order) => order.orderId))
      setSkuSortActive(true)
      return
    }

    setSkuSortActive(false)
  }

  const openShipStationOrder = (orderId: number) => {
    window.open(`https://ship.shipstation.com/orders/${orderId}`, '_blank', 'noopener,noreferrer')
  }

  const allActiveQueueEntries = queueEntriesClientId === queueClientId ? queueEntries : EMPTY_QUEUE_ENTRIES
  // The distinct clients present in the (all-scope) queue — drives the Print Queue client dropdown.
  const queueClients = useMemo(() => {
    const byId = new Map<number, string>()
    for (const entry of allActiveQueueEntries) {
      const id = Number((entry as { client_id?: unknown }).client_id)
      if (!Number.isFinite(id) || id <= 0 || byId.has(id)) continue
      const matchingOrder = [panelOrder, ...orders].find((order) => order?.clientId === id)
      const matchingStore = stores.find((store) => store.clientId === id)
      byId.set(id, matchingOrder?.clientName || matchingStore?.storeName || matchingStore?.name || `Client ${id}`)
    }
    return [...byId.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [allActiveQueueEntries, orders, panelOrder, stores])
  // Display set: when a client is selected, show only that client's entries. null ref-stable
  // pass-through keeps the downstream useMemos from recomputing when no filter is active.
  const activeQueueEntries = useMemo(() => (
    pqClientFilter == null
      ? allActiveQueueEntries
      : allActiveQueueEntries.filter((entry) => Number((entry as { client_id?: unknown }).client_id) === pqClientFilter)
  ), [allActiveQueueEntries, pqClientFilter])
  const queuedEntries = useMemo(
    () => activeQueueEntries.filter((entry) => entry.status === 'queued'),
    [activeQueueEntries],
  )
  const queuedEntryIds = useMemo(
    () => queuedEntries.map((entry) => entry.queue_entry_id),
    [queuedEntries],
  )
  // History = everything that left the active queue: confirmed-printed entries
  // AND tracking-retired 'delivered' entries (carrier confirmed the package
  // reached the customer; its label never needs printing).
  const printedEntries = useMemo(
    () => queueHistoryVisible ? activeQueueEntries.filter((entry) => entry.status !== 'queued') : [],
    [activeQueueEntries, queueHistoryVisible],
  )
  const queueGroups = useMemo<PrintQueueGroup[]>(
    () => groupPrintQueueEntries(activeQueueEntries as any),
    [activeQueueEntries],
  )
  const queueCount = queuedEntries.length
  const queueConfirmPrintedReady = queueCount > 0 && queuedEntryIds.every((entryId) => queuePrintReadyEntryIds.has(entryId))
  const unprintedQueueCount = queuedEntryIds.filter((entryId) => !queuePrintReadyEntryIds.has(entryId)).length
  useEffect(() => {
    const activeIds = new Set(queuedEntryIds)
    setQueuePrintReadyEntryIds((current) => {
      const next = new Set([...current].filter((entryId) => activeIds.has(entryId)))
      return next.size === current.size ? current : next
    })
  }, [queuedEntryIds])
  // PS-194: Confirm-Printed survives a page refresh. Re-seed the print-ready
  // set from the backend's LAST merge job (durable snapshot) — the entries
  // that actually merged into a printed PDF are backend truth, not session
  // state. The pruning effect above intersects with the live queue, so ids
  // from already-confirmed/removed entries fall away naturally.
  useEffect(() => {
    let cancelled = false
    void apiClient.fetchQueuePrintLastJob().then(({ job }) => {
      if (cancelled || !job || job.status !== 'done') return
      const ids = Array.isArray(job.successful_entry_ids)
        ? (job.successful_entry_ids as unknown[]).filter((id): id is string => typeof id === 'string')
        : []
      if (!ids.length) return
      setQueuePrintReadyEntryIds((current) => {
        const next = new Set(current)
        ids.forEach((id) => next.add(id))
        return next.size === current.size ? current : next
      })
    })
    return () => { cancelled = true }
  }, [])
  // Search & sort applied to the queue and history lists. Search matches the
  // order number OR the order_id (cast to string) — covers both how users
  // type queries (full order #, partial digits, etc.).
  const pqSearchLower = pqSearch.trim().toLowerCase()
  const matchesPqSearch = (entry: { order_number?: string | null; order_id?: number | string | null }) => {
    if (!pqSearchLower) return true
    const num = String(entry.order_number ?? '').toLowerCase()
    const id = String(entry.order_id ?? '').toLowerCase()
    return num.includes(pqSearchLower) || id.includes(pqSearchLower)
  }
  const matchesQueueGroupSearch = (group: PrintQueueGroup) => {
    if (!pqSearchLower) return true
    const label = group.label.toLowerCase()
    const description = group.description.toLowerCase()
    const searchableOrders = group.orders.some((entry) => {
      const primarySku = String(entry.primary_sku ?? '').toLowerCase()
      const skuGroup = String(entry.sku_group_id ?? '').toLowerCase()
      const itemDescription = String(entry.item_description ?? '').toLowerCase()
      return matchesPqSearch(entry) ||
        primarySku.includes(pqSearchLower) ||
        skuGroup.includes(pqSearchLower) ||
        itemDescription.includes(pqSearchLower)
    })
    return label.includes(pqSearchLower) ||
      description.includes(pqSearchLower) ||
      group.searchText.includes(pqSearchLower) ||
      searchableOrders
  }
  const visibleQueueGroups = useMemo<PrintQueueGroup[]>(() => {
    if (!pqSearchLower) return queueGroups
    return queueGroups.filter(matchesQueueGroupSearch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueGroups, pqSearchLower])
  const visiblePrintedEntries = useMemo(() => {
    const filtered = pqSearchLower ? printedEntries.filter(matchesPqSearch as any) : printedEntries
    // History timestamp: printed entries sort by their confirm time, delivered
    // entries by the tracking-retirement time.
    const historyTime = (entry: { last_printed_at?: string | null; auto_retired_at?: string | null }) => {
      const stamp = entry.last_printed_at ?? entry.auto_retired_at
      return stamp ? Date.parse(stamp) : 0
    }
    const sorted = [...filtered].sort((a, b) => {
      const aT = historyTime(a)
      const bT = historyTime(b)
      return pqHistoryAsc ? aT - bT : bT - aT
    })
    return sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printedEntries, pqSearchLower, pqHistoryAsc])
  const queueHasVisibleEntries = visibleQueueGroups.length > 0 || visiblePrintedEntries.length > 0
  const queueActionProgressPct = queueActionProgress
    ? Math.round((queueActionProgress.completed / Math.max(queueActionProgress.total, 1)) * 100)
    : 0
  const queueActionElapsedSeconds = queueActionProgress
    ? Math.max(0, Math.floor((Date.now() - queueActionProgress.startedAt) / 1000))
    : 0
  const queueToolbarProgress = queueActionProgress
    ? {
      label: queueActionProgress.label,
      detail: formatQueueActionProgressDetail(queueActionProgress, queueActionElapsedSeconds),
      pct: queueActionProgressPct,
      tone: queueActionProgress.failed > 0 || queueActionProgress.skipped > 0 ? '#f59e0b' : 'var(--ss-blue)',
    }
    : queuePrintInFlight && queuePrintMessage
      ? {
        label: 'Print queue',
        detail: queuePrintMessage,
        pct: queuePrintProgress ?? 0,
        tone: 'var(--ss-blue)',
      }
      : null

  // PS-166/PS-306 (Wave 4): the #exportBtn onClick body stays PARENT-OWNED. The
  // CSV export is real async work (apiClient.downloadOrdersExport) and must not
  // live in the presentational OrdersFilterToolbar — OrdersFilterToolbarExport
  // only FIRES this callback. Body lifted VERBATIM from the former inline arrow.

  // PS-345: per-row Retry is explicit operator intent. It delegates to the same
  // backend strict recalculate path as batch recalc instead of re-triggering a
  // page-mount passive rating effect.
  function retryOrderRate(order: OrderSummaryDto) {
    const request = getAutoBestRateRequest(order)
    if (request) {
      setAutoBestRateEntry(order.orderId, { key: request.key, rate: null, pending: true })
    }
    void runBatchRecalculateOrder(order)
      .then((result) => {
        if (request && result.status === 'skipped') {
          setAutoBestRateEntry(order.orderId, { key: request.key, rate: null, error: result.message ?? 'Rate recalculation skipped.' })
        }
      })
      .catch((error) => {
        if (!request) return
        setAutoBestRateEntry(order.orderId, {
          key: request.key,
          rate: null,
          error: sanitizeRecalculateError(error) ?? 'Rate recalculation failed.',
        })
      })
      .finally(() => {
        void refetchOrders()
      })
  }

  async function getBatchRecalculateOrders(scope: BatchRecalculateScope) {
    const targetOrders =
      scope === 'selected'
        ? await hydrateSelectedOrdersForActions()
        : await apiClient.fetchMatchingOrdersForSelection(
          buildFilteredAwaitingRecalculateQuery(matchingSelectionQuery),
        )
    const selection = selectBatchRecalculateOrderIds({
      currentStatus,
      scope,
      orders: targetOrders,
      selectedOrderIds,
      visibleOrderIds,
      matchingOrderIds: targetOrders.map((order) => order.orderId),
    })
    const orderById = new Map(targetOrders.map((order) => [order.orderId, order]))
    return {
      selection,
      targetOrders: selection.orderIds
        .map((orderId) => orderById.get(orderId))
        .filter((order): order is OrderSummaryDto => Boolean(order)),
    }
  }

  async function runBatchRecalculateOrder(order: OrderSummaryDto): Promise<BatchRecalculateRowState> {
    if (order.orderStatus !== 'awaiting_shipment') {
      return { status: 'skipped', message: 'Only awaiting orders can be recalculated.' }
    }
    if (isTestOrder(order)) {
      return { status: 'skipped', message: 'Test order uses mock rates.' }
    }

    const request = getAutoBestRateRequest(order)
    if (!request) {
      return { status: 'skipped', message: 'Missing weight, dimensions, or ship-to postal code.' }
    }
    if (accountsLoading) {
      setAutoBestRateEntry(order.orderId, {
        key: request.key,
        rate: null,
        error: 'Carrier accounts are still loading.',
      })
      return { status: 'blocked', message: 'Carrier accounts are still loading.' }
    }
    if (!request.carrierIds.length) {
      const message = 'No carrier accounts are available for this order scope.'
      setAutoBestRateEntry(order.orderId, { key: request.key, rate: null, error: message })
      return { status: 'blocked', message }
    }

    try {
      const result = await runStrictBestRateRecalculation(order, request, {
        timeoutMs: BATCH_RECALCULATE_TIMEOUT_MS,
        updatePanel: panelOrderId === order.orderId,
      })
      if (result.status === 'updated') return { status: 'updated', message: result.message }
      if (result.status === 'cleared') return { status: 'cleared', message: result.message }
      return { status: 'blocked', message: result.message }
    } catch (error) {
      const message = sanitizeRecalculateError(error)
      setAutoBestRateEntry(order.orderId, {
        key: request.key,
        rate: null,
        error: message,
      })
      if (isBatchRecalculateTimeout(error)) return { status: 'timed-out', message }
      return { status: 'blocked', message }
    }
  }

  async function startBatchRecalculateBestRates(scope: BatchRecalculateScope) {
    if (batchRecalculateBusy) return
    const { selection, targetOrders } = await getBatchRecalculateOrders(scope)
    if (selection.blockedReason) {
      showToast(selection.blockedReason, 'error')
      return
    }
    if (targetOrders.length === 0) {
      showToast(
        scope === 'selected'
          ? 'Select one or more awaiting orders to recalculate'
          : 'No filtered awaiting orders can be recalculated',
        'error',
      )
      return
    }

    const runId = batchRecalculateRunRef.current + 1
    batchRecalculateRunRef.current = runId
    const prepared = prepareBatchRecalculateRows(targetOrders, (order) => {
      if (isTestOrder(order)) {
        return { queueable: false, row: { status: 'skipped', message: 'Test order uses mock rates.' } }
      }
      const request = getAutoBestRateRequest(order)
      if (!request) {
        return { queueable: false, row: { status: 'skipped', message: 'Missing weight, dimensions, or ship-to postal code.' } }
      }
      return { queueable: true }
    })
    const finalRows: Record<number, BatchRecalculateRowState> = { ...prepared.rows }
    const queueableOrders = prepared.queueableOrders
    setBatchRecalculateRows({ ...finalRows })
    if (queueableOrders.length === 0) {
      showToast('No rateable awaiting orders found. Add dims, weight, and ship-to postal codes first.', 'info')
      return
    }
    setBatchRecalculateBusy(true)

    const queue = [...queueableOrders]
    const workerCount = Math.min(BATCH_RECALCULATE_CONCURRENCY, queue.length)
    async function worker() {
      while (queue.length > 0 && batchRecalculateRunRef.current === runId) {
        const order = queue.shift()
        if (!order) return
        setBatchRecalculateRow(order.orderId, { status: 'running', message: 'Fetching strict live rates.' })
        const row = await runBatchRecalculateOrder(order)
        finalRows[order.orderId] = row
        if (batchRecalculateRunRef.current === runId) setBatchRecalculateRow(order.orderId, row)
      }
    }

    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()))
      await refetchOrders()
      const { summary, message } = formatBatchRecalculateFinishedMessage(finalRows, selection.skippedImmutable)
      showToast(message, summary.updated > 0 ? 'success' : 'info')
    } finally {
      if (batchRecalculateRunRef.current === runId) {
        setBatchRecalculateBusy(false)
        // Show the completed 100% summary briefly, then auto-clear the progress
        // bar — it is redundant with the "Recalculate finished" toast and would
        // otherwise linger forever. Guarded on runId so a newer run's rows are
        // never wiped out by a stale timer.
        window.setTimeout(() => {
          if (batchRecalculateRunRef.current === runId) setBatchRecalculateRows({})
        }, 3000)
      }
    }
  }

  async function retryBatchRecalculateOrder(order: OrderSummaryDto) {
    if (batchRecalculateBusy) {
      showToast('Batch Recalculate is still running. Retry after it finishes.', 'error')
      return
    }
    setBatchRecalculateBusy(true)
    setBatchRecalculateRow(order.orderId, { status: 'running', message: 'Retrying strict live rates.' })
    try {
      const row = await runBatchRecalculateOrder(order)
      setBatchRecalculateRow(order.orderId, row)
      await refetchOrders()
      showToast(row.message ?? 'Recalculate retry finished', row.status === 'updated' ? 'success' : 'info')
    } finally {
      setBatchRecalculateBusy(false)
    }
  }

  // PS-071 — render the bounded/actionable fallback for an awaiting rate cell.
  // The historically-infinite no-rate cases resolve to a terminal label instead
  // of an endless <span className="spin-sm" />.
  function renderRateCellFallback(
    state: AwaitingRateCellState,
    order: OrderSummaryDto,
    variant: 'full' | 'compact',
  ) {
    const muted: React.CSSProperties = { fontSize: 10.5, color: 'var(--text3)' }
    const linkBtn: React.CSSProperties = {
      fontSize: 10.5,
      color: 'var(--ss-blue)',
      background: 'none',
      border: 'none',
      padding: 0,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    if (state === 'add-dims') {
      // PS-119: missing/incomplete dims or weight is an ACTIONABLE input-needed state —
      // never a carrier/rate failure. Route the operator straight to the order's
      // detail panel (where dims/weight are edited) instead of a dead "Rate unavailable".
      return variant === 'compact' ? (
        <span data-rate-state="add-dims" title="Add dimensions / weight to rate this order" style={muted}>&mdash; add dims</span>
      ) : (
        <button
          type="button"
          data-rate-state="add-dims"
          title="Add dimensions / weight to rate this order"
          style={linkBtn}
          onClick={() => onActiveOrderIdChange?.(order.orderId)}
        >
          Add dims
        </button>
      )
    }
    const batchRow = batchRecalculateRows[order.orderId]
    if (batchRow?.status === 'pending' || batchRow?.status === 'running') {
      return (
        <div
          className="spin-center"
          data-rate-state={`batch-${batchRow.status}`}
          title={batchRow.message ?? 'Recalculating strict live rate...'}
          role="status"
          aria-label="Loading best rate"
        >
          <span className="spin-sm" />
        </div>
      )
    }
    if (batchRow && canRetryBatchRecalculateRow(batchRow)) {
      const label =
        batchRow.status === 'timed-out'
          ? 'Timed out'
          : batchRow.status === 'cleared'
            ? 'Unavailable'
            : 'Blocked'
      if (variant === 'compact') {
        return (
          <span
            data-rate-state={`batch-${batchRow.status}`}
            title={`${label}: ${batchRow.message ?? 'Retry strict live recalculation'}`}
            style={{ ...muted, color: batchRow.status === 'cleared' ? 'var(--text3)' : 'var(--red)' }}
          >
            —
          </span>
        )
      }
      return (
        <button
          type="button"
          data-batch-recalculate-retry
          data-rate-state={`batch-${batchRow.status}`}
          title={`${label}: ${batchRow.message ?? 'Retry strict live recalculation'}`}
          style={{ ...linkBtn, color: batchRow.status === 'cleared' ? 'var(--ss-blue)' : 'var(--red)' }}
          onClick={() => void retryBatchRecalculateOrder(order)}
        >
          {label} · Retry
        </button>
      )
    }
    switch (state) {
      case 'loading-carriers':
        return (
          <span data-rate-state="loading-carriers" title="Loading carrier accounts…" style={muted}>
            Loading carriers…
          </span>
        )
      case 'no-carrier-account':
        return variant === 'compact' ? (
          <span data-rate-state="no-carrier-account" title="No carrier account connected" style={muted}>—</span>
        ) : (
          <button
            type="button"
            data-rate-state="no-carrier-account"
            title="No carrier account connected — open Browse Rates / connect a carrier in Settings"
            style={linkBtn}
            onClick={() => setRateBrowserOpen(true)}
          >
            No carrier account
          </button>
        )
      case 'error': {
        // PS-075 — terminal error (rate lookup failed for this order). Show a
        // Retry affordance; tooltip carries the sanitized message.
        const autoReq = getAutoBestRateRequest(order)
        const errMsg = autoReq ? autoBestRateEntries[order.orderId]?.error : null
        return variant === 'compact' ? (
          <span data-rate-state="error" title={errMsg ? `Rate error: ${errMsg}` : 'Rate lookup failed'} style={{ ...muted, color: 'var(--red)' }}>—</span>
        ) : (
          <button
            type="button"
            data-rate-state="error"
            title={errMsg ? `Rate error: ${errMsg} — click to retry` : 'Rate lookup failed — click to retry'}
            style={{ ...linkBtn, color: 'var(--red)' }}
            onClick={() => retryOrderRate(order)}
          >
            Rate error · Retry
          </button>
        )
      }
      case 'unavailable':
        return variant === 'compact' ? (
          <span data-rate-state="unavailable" title="No rate found for this order" style={muted}>—</span>
        ) : (
          <button
            type="button"
            data-rate-state="unavailable"
            title="No rate found for this order — retry rating"
            style={linkBtn}
            onClick={() => retryOrderRate(order)}
          >
            Rate unavailable · Retry
          </button>
        )
      case 'stale':
        return variant === 'compact' ? (
          <span data-rate-state="stale" title="Saved rate out of date - re-rate required" style={muted}>-</span>
        ) : (
          <button
            type="button"
            data-rate-state="stale"
            title="Saved rate out of date - click to refresh rates"
            style={linkBtn}
            onClick={() => retryOrderRate(order)}
          >
            Re-rate needed
          </button>
        )
      // PS-345: 'deferred' means backend workflow state says a rate job has not
      // resolved yet. The row can show the same spinner as calculating/pending,
      // but this view no longer starts a live browser drain to resolve it.
      case 'deferred':
      case 'calculating':
      case 'pending':
      default:
        return (
          <div
            className="spin-center"
            data-rate-state={state}
            title="Fetching rate..."
            role="status"
            aria-label="Loading best rate"
          >
            <span className="spin-sm" />
          </div>
        )
    }
  }

  // PS-071 — compute the bounded state for an awaiting order's rate cell. Returns
  // null when a real rate is displayable (caller renders it); otherwise returns
  // the terminal/loading fallback element.
  function renderAwaitingRateFallback(
    order: OrderSummaryDto,
    displayOrder: OrderSummaryDto,
    variant: 'full' | 'compact',
  ) {
    const dims = getDimensions(displayOrder, null)
    const hasDims = hasCompleteDims(dims)
    const hasWeight = Boolean(displayOrder.weight?.value && displayOrder.weight.value > 0)
    const hasDisplayableBestRate = hasDisplayableBestRateForCurrentRequest(displayOrder)
    const isCalculatingBestRate = !hasDisplayableBestRate && hasAnySavedBestRateForDisplay(displayOrder)
    const autoRequest = getAutoBestRateRequest(order)
    const autoEntry = autoRequest ? autoBestRateEntries[order.orderId] : null
    const resolvedForKey = Boolean(autoRequest && autoEntry?.key === autoRequest.key)
    // PS-075 — distinguish a terminal ERROR from a genuine no-rate result.
    const resolvedError = resolvedForKey && Boolean(autoEntry?.error)
    const resolvedNoRate = resolvedForKey && autoEntry?.pending !== true && !autoEntry?.rate && !autoEntry?.error
    const isAutoRatingActive = resolvedForKey && autoEntry?.pending === true
    const hasCarrierContext = isTestOrder(displayOrder) || getRateCarrierIdsForAccounts().length > 0
    const batchRow = batchRecalculateRows[order.orderId]
    const stateInput = {
      hasDims,
      hasWeight,
      hasDisplayableBestRate,
      isCalculatingBestRate,
      resolvedNoRate,
      resolvedError,
      hasCarrierContext,
      accountsLoading,
      isAutoRatingActive,
      batchRecalculateStatus: batchRow?.status,
    }
    const state = classifyAwaitingRateCellStateWithWorkflow(
      getBestRateWorkflowModel(displayOrder),
      stateInput,
    )
    if (state === 'ready') return null
    return renderRateCellFallback(state, order, variant)
  }

  // PS-166/PS-306/PS-258 (Wave 2): the four leaf cell renderers moved VERBATIM to
  // ./orders/cells/order-cells. They are pure display-only readers of the backend
  // money DTO + injected backend rate/coverage verdicts (no recompute, no apiClient).
  // Assemble the typed DI object once so renderTableCell's call sites stay clean; the
  // shell keeps owning the component-scoped closures these leaves read.
  // PS-312/PS-317 (S4): combined-shipment bundle state for the visible rows, from the scope-safe
  // backend read-model. The carrier cell renders a child's shared shipment instead of a sync-error.
  const bundleByOrderId = useOrderBundles((orders ?? []).map((order) => order.orderId))
  const orderCellsDeps: OrderCellsDeps = {
    getOrderWithAutoBestRate,
    orderShippingHold,
    renderAwaitingRateFallback,
    hasDisplayableBestRateForCurrentRequest,
    getAwaitingBestRateDisplayState,
    getRateBaseAmount,
    shippingAccounts,
    bundleByOrderId,
  }
  const renderBestRatePrice = (order: OrderSummaryDto) => renderBestRatePriceCell(order, orderCellsDeps)
  const renderMargin = (order: OrderSummaryDto) => renderMarginCell(order, orderCellsDeps)
  const renderCarrierCell = (order: OrderSummaryDto) => renderCarrierCellLeaf(order, orderCellsDeps)
  const renderShippingAccountCell = (order: OrderSummaryDto) => renderShippingAccountCellLeaf(order, orderCellsDeps)

  // Row-invariant work shared by every cell of one row. renderTableCell used to
  // recompute this block once per CELL (~once per visible column); the per-render
  // cache below computes it once per ROW. The cache Map is recreated on every
  // render pass, so an entry can never outlive the state it was derived from
  // (orderDetailsById / skuFilter / the closures captured this render).
  const buildOrderRowCellContext = (order: OrderSummaryDto) => {
    const detail = orderDetailsById.get(order.orderId) ?? null
    const items = getActiveItems(order, detail)
    const mergedItems = getMergedItems(order, detail)
    // When the SKU filter is active, the row's "primary" displayed
    // item should be the one matching the filter — not just whatever
    // happens to be first in the array. Without this swap, an order
    // matching the filter via a non-first item would display the
    // unrelated first item, making the filter LOOK broken even when
    // it correctly narrowed the result set.
    //
    // Normalized (trim + lowercase) compare matches the searchedOrders
    // memo above, so the row display is consistent with the filter
    // gate — both treat 'B-6' / 'b-6 ' / ' B-6' as the same SKU.
    const skuNeedleForRow = skuFilter.trim().toLowerCase()
    const primaryItem = (skuNeedleForRow
      ? items.find((item) => (item.sku ?? '').trim().toLowerCase() === skuNeedleForRow)
      : items[0]) ?? items[0] ?? null
    const multiSku = new Set(items.map((item) => item.sku).filter(Boolean)).size > 1
    const skuDisplayByItemKey = new Map(
      resolveSkuDisplayLines(items, { titleFallback: isEbayOrder(order) })
        .map((line, index) => [`${items[index]?.sku ?? 'unknown'}-${items[index]?.name ?? 'item'}`, line] as const),
    )
    const primarySkuDisplay = primaryItem
      ? resolveSkuDisplayLines([primaryItem], { titleFallback: isEbayOrder(order) })[0] ?? null
      : null
    const renderSkuQuantityBadge = (quantity: number) => (
      quantity > 1 ? (
        <span
          style={{ background: 'var(--ss-blue-bg)', color: 'var(--ss-blue)', fontSize: 9.5, fontWeight: 700, padding: '0 4px', borderRadius: 3, flexShrink: 0 }}
          title={`Quantity ${quantity}`}
          aria-label={`quantity ${quantity}`}
        >
          ×{quantity}
        </span>
      ) : null
    )
    const expedited = getExpeditedBadge(order, detail)
    const shipTo = getShipTo(order, detail)
    const clientName = order.clientName ?? 'Untagged'
    const clientPalette = getClientPalette(clientName)
    return {
      detail,
      items,
      mergedItems,
      primaryItem,
      multiSku,
      skuDisplayByItemKey,
      primarySkuDisplay,
      renderSkuQuantityBadge,
      expedited,
      shipTo,
      clientName,
      clientPalette,
    }
  }
  const orderRowCellContextCache = new Map<number, ReturnType<typeof buildOrderRowCellContext>>()
  const getOrderRowCellContext = (order: OrderSummaryDto) => {
    const cached = orderRowCellContextCache.get(order.orderId)
    if (cached) return cached
    const context = buildOrderRowCellContext(order)
    orderRowCellContextCache.set(order.orderId, context)
    return context
  }

  const renderTableCell = (order: OrderSummaryDto, column: TableColumn) => {
    const {
      detail,
      items,
      mergedItems,
      primaryItem,
      multiSku,
      skuDisplayByItemKey,
      primarySkuDisplay,
      renderSkuQuantityBadge,
      expedited,
      shipTo,
      clientName,
      clientPalette,
    } = getOrderRowCellContext(order)

    switch (column.key) {
      case 'select':
        // Lockdown — no row selection on Shipped / Cancelled. Cell
        // renders empty so the column still reserves its width but no
        // checkbox is interactive.
        if (isReadOnly) return null
        const isBulkSelected = selectedIdSet.has(order.orderId)
        const isOpenInPanel = panelOrderId === order.orderId
        return (
          <input
            type="checkbox"
            checked={isBulkSelected}
            ref={(node) => {
              if (node) node.indeterminate = isOpenInPanel && !isBulkSelected
            }}
            onMouseDown={(event) => {
              shiftHeldOnMouseDownRef.current = event.shiftKey
            }}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              event.stopPropagation()
              const wasShift = shiftHeldOnMouseDownRef.current
              shiftHeldOnMouseDownRef.current = false
              const anchor = lastSelectionAnchorRef.current
              if (wasShift && anchor != null && anchor !== order.orderId) {
                selectOrderRange(anchor, order.orderId)
                return
              }
              lastSelectionAnchorRef.current = order.orderId
              toggleOrderSelection(order.orderId, event.target.checked)
            }}
            aria-checked={isOpenInPanel && !isBulkSelected ? 'mixed' : isBulkSelected}
            aria-label={`${isOpenInPanel && !isBulkSelected ? 'Open in detail panel. Check to select' : 'Select'} ${order.orderNumber ?? order.orderId}. Shift+click to select a range.`}
            title={isOpenInPanel && !isBulkSelected ? 'Open in detail panel. Check to add to bulk actions.' : 'Tip: Shift+click another checkbox to select a range'}
          />
        )
      case 'date':
        return (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {expedited ? (
              <span
                className={`expedited-badge expedited-badge--${expedited.tier}`}
                data-expedited-tier={expedited.tier}
                title={`Expedited shipping requested: ${expedited.label}`}
              >
                {expedited.label}
              </span>
            ) : null}
            <div style={{ fontSize: 11.5, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{formatDateTime(order.orderDate)}</div>
          </div>
        )
      case 'client':
        return (
          <span
            className="client-badge"
            style={{ background: clientPalette.bg, color: clientPalette.color, borderColor: clientPalette.border }}
          >
            {truncate(clientName, 14)}
          </span>
        )
      case 'orderNum':
        return renderOrderCell(order, {
          orderDetailsById,
          transitionalShippedIds,
          isGlobalSearchActive,
          currentStatus,
          openDetailDrawer,
        })
      case 'customer': {
        // Tiny "Assigned to" badge under the customer name. Only renders when
        // the order has an assignee — keeps the cell quiet for unassigned
        // rows. Uses the email's local-part (before @) so it stays narrow.
        const assignedEmail = toStringValue(order.assignedToEmail)
        const assignedLocal = assignedEmail ? assignedEmail.split('@')[0] : null
        return (
          <div>
            <div className="customer-name">{shipTo.name ?? '—'}</div>
            {/* PS-276 (slice 4-UI): compact resi/comm verdict at a glance (display-only). */}
            <div className="mt-0.5 text-[9.5px]"><ResidentialTag facts={residentialTagFacts(order)} /></div>
            {assignedLocal ? (
              <div
                title={`Assigned to ${assignedEmail}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  marginTop: 2,
                  fontSize: 9.5,
                  fontWeight: 700,
                  color: '#6d28d9',
                  background: 'rgba(124, 58, 237, .12)',
                  padding: '1px 6px',
                  borderRadius: 999,
                  lineHeight: 1.4,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span aria-hidden="true">👤</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{assignedLocal}</span>
              </div>
            ) : null}
          </div>
        )
      }
      case 'itemname':
        if (multiSku) {
          const visibleItems = mergedItems.slice(0, 5)
          const overflow = mergedItems.length - visibleItems.length
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '3px 0', maxWidth: column.width + 90, overflow: 'hidden' }}>
              {visibleItems.map((item) => (
                <div key={`${item.sku ?? 'unknown'}-${item.name ?? 'item'}`} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <HoverImage
                    src={item.imageUrl}
                    alt={item.name ?? ''}
                    size={22}
                    radius={3}
                    title={item.name ?? ''}
                    fallback={
                      <span style={{ width: 22, height: 22, flexShrink: 0, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, display: 'inline-block' }} />
                    }
                  />
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, minWidth: 0 }}>
                      {item.name ?? item.sku ?? '—'}
                    </span>
                    {item.quantity > 1 ? (
                      <span style={{ background: 'var(--ss-blue-bg)', color: 'var(--ss-blue)', fontSize: 9.5, fontWeight: 700, padding: '0 4px', borderRadius: 3, flexShrink: 0 }}>
                        ×{item.quantity}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
              {overflow > 0 ? <div style={{ fontSize: 10.5, color: 'var(--text3)', paddingLeft: 27 }}>+{overflow} more</div> : null}
            </div>
          )
        }
        return (
          <div className="cell-itemname" title={primaryItem?.name ?? '—'} style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: column.width + 90 }}>
            <HoverImage
              src={primaryItem?.imageUrl ?? null}
              alt={primaryItem?.name ?? ''}
              size={28}
              radius={4}
              title={primaryItem?.name ?? ''}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {primaryItem?.name ?? '—'}
              {items.length > 1 && !multiSku ? <span style={{ color: 'var(--text3)', fontSize: 10.5 }}> ×{getTotalQuantity(order, detail)}</span> : null}
            </span>
          </div>
        )
      case 'sku':
        if (multiSku) {
          const visibleItems = mergedItems.slice(0, 5)
          const overflow = mergedItems.length - visibleItems.length
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '3px 0' }}>
              {visibleItems.map((item) => (
                <div key={`${item.sku ?? 'unknown'}-${item.name ?? 'item'}`} style={{ display: 'flex', alignItems: 'center', height: 22, gap: 3, minWidth: 0 }}>
                  {(() => {
                    const display = skuDisplayByItemKey.get(`${item.sku ?? 'unknown'}-${item.name ?? 'item'}`)
                    return display?.label ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }} title={`${display.label}${item.quantity > 1 ? ` quantity ${item.quantity}` : ''}`}>
                        <span className="sku-link" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={display.label}>{display.label}</span>
                        {renderSkuQuantityBadge(item.quantity)}
                      </span>
                    ) : <span style={{ color: 'var(--text4)', fontSize: 11 }}>—</span>
                  })()}
                </div>
              ))}
              {overflow > 0 ? <div style={{ height: 14 }} /> : null}
            </div>
          )
        }
        if (!primarySkuDisplay?.label) return '—'
        const totalQuantity = getTotalQuantity(order, detail)
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: column.width + 60, minWidth: 0, overflow: 'hidden' }} title={`${primarySkuDisplay.label}${totalQuantity > 1 ? ` quantity ${totalQuantity}` : ''}`}>
            <span className="sku-link" title={primarySkuDisplay.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{primarySkuDisplay.label}</span>
            {renderSkuQuantityBadge(totalQuantity)}
          </span>
        )
      case 'qty': {
        const totalQuantity = getTotalQuantity(order, detail)
        return (
          <div style={{ display: 'flex', justifyContent: 'center', width: '100%', fontWeight: 700, color: 'var(--text2)' }}>
            {totalQuantity > 1 ? (
              <span style={{ display: 'inline-block', padding: '1px 6px', border: '2px solid var(--red)', borderRadius: 4, color: 'var(--red)' }}>{totalQuantity}</span>
            ) : (
              totalQuantity || '—'
            )}
          </div>
        )
      }
      case 'weight':
        if (isTestOrder(order, detail)) {
          const weightOz = getOrderWeightOz(order, detail)
          return weightOz ? <span style={{ fontSize: 12, color: 'var(--text2)' }}>{formatWeight(weightOz)}</span> : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
        }
        return order.weight?.value ? <span style={{ fontSize: 12, color: 'var(--text2)' }}>{formatWeight(order.weight.value)}</span> : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
      case 'shipto':
        return <span style={{ fontSize: 11.5, color: 'var(--text2)' }}>{getShipToLine(order, detail)}</span>
      case 'carrier':
        return renderCarrierCell(order)
      case 'custcarrier':
        return renderShippingAccountCell(order)
      case 'total':
        return renderOrderTotalCell(order)
      case 'bestrate':
        return renderBestRatePrice(order)
      case 'bestRateFinal':
        return renderBestRateFinalCell(order)
      case 'ratecost':
        return renderCShippingRateCell(order)
      case 'margin':
        return renderMargin(order)
      case 'marketplacefee':
        return renderMarketplaceFeeCell(order)
      case 'profit':
        return renderProfitCell(order)
      case 'tracking':
        {
          const trackingNumber = toStringValue(order.label?.trackingNumber)
          if (!trackingNumber) {
            return <span style={{ color: 'var(--text4)', fontFamily: 'monospace', fontSize: 11 }}>—</span>
          }
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontFamily: 'monospace' }}>
              <span
                style={{ color: 'var(--ss-blue)', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                onClick={(event) => {
                  event.stopPropagation()
                  setTrackingModal({
                    tracking: trackingNumber,
                    carrierCode: toStringValue(order.label?.carrierCode) ?? toStringValue((order.bestRate as any)?.carrierCode) ?? toStringValue(order.carrierCode),
                  })
                }}
                title="Track package"
              >
                {trackingNumber}
              </span>
              <span
                onClick={(event) => {
                  event.stopPropagation()
                  copyText(trackingNumber)
                }}
                style={{ cursor: 'pointer', color: 'var(--text4)', fontSize: 9, opacity: 0.6 }}
                title="Copy tracking number"
                onMouseEnter={(event) => { event.currentTarget.style.opacity = '1' }}
                onMouseLeave={(event) => { event.currentTarget.style.opacity = '0.6' }}
              >
                ⎘
              </span>
            </span>
          )
        }
      case 'labelcreated':
        return (
          <span style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
            {formatLabelCreated(order.label?.createdAt ?? null)}
          </span>
        )
      case 'age': {
        const ageColor = getAgeColor(order.orderDate)
        return (
          <div className="age-wrap">
            <span className="age-dot" style={{ background: ageColor }} />
            <span style={{ fontSize: 11, color: ageColor === 'var(--green)' ? 'var(--text3)' : ageColor }}>{ageLabel(order.orderDate)}</span>
          </div>
        )
      }
      case 'test_carrierCode':
      case 'test_shippingProviderID':
      case 'test_clientID':
      case 'test_serviceCode':
      case 'test_bestRate':
      case 'test_orderLocal':
      case 'test_shippingAccount':
        // PS-166 (Wave 2c2): the diagnostic column cells are pure on
        // (order, column) — moved VERBATIM to renderDiagnosticColumnCell.
        return renderDiagnosticColumnCell(order, column)
    }
  }

  // PS-306 (Wave 5): the side-panel backend-truth handlers stay PARENT-OWNED.
  // The extracted <OrdersDetailSidePanel> leaf is presentational and only FIRES
  // these via on* props — it owns no apiClient call, no selected-pid/package
  // persistence, no rate re-fetch, and no label purchase. Each handler keeps the
  // exact body that previously lived inline in renderSinglePanel.
  const handlePanelShipAccountChange = (nextValue: string) => {
    if (!panelOrder) return
    setPanelForm((current) => {
      // PS-189: NEVER auto-default a service the operator didn't
      // choose (the old `[0]?.code` silently stamped
      // usps_media_mail — a restricted, books-only service — on
      // stamps_com switches). Keep the current service if the new
      // account offers it; otherwise force an explicit pick.
      const nextOptions = getServiceOptionsForAccount(nextValue)
      const keepService = nextOptions.some((option) => option.code === current.serviceCode)
      return {
        ...current,
        shipAccountId: nextValue,
        serviceCode: keepService ? current.serviceCode : '',
      }
    })
    // PS-204: a preview rate quoted for the PREVIOUS account is
    // stale for the new selection — drop it instead of letting
    // it dress the new account with another account's amount.
    // Re-rating (Browse Rates / preview fetch) repopulates it
    // for the chosen account.
    setPanelRatePreview((current) => {
      const belongs = rateBelongsToProviderAccount(current[0], nextValue)
      return belongs === false ? [] : current
    })
    void apiClient.setOrderSelectedPid(panelOrder.orderId, nextValue ? Number.parseInt(nextValue, 10) : null)
  }

  const handlePanelPackageChange = (packageId: string) => {
    if (!panelOrder) return
    const selectedPackage = packages.find((candidate) => getPackageIdentifier(candidate) === packageId)
    const selectedDims = getPackageDims(selectedPackage)
    // User-driven package change should trigger an
    // auto-rate-refresh — flag it as a real edit.
    dimsUserEditedRef.current = true
    setPanelForm((current) => ({
      ...current,
      packageId,
      ...(selectedDims
        ? {
          length: String(selectedDims.length),
          width: String(selectedDims.width),
          height: String(selectedDims.height),
        }
        : {}),
    }))
    void apiClient.setOrderSelectedPackageId(panelOrder.orderId, packageId ? Number.parseInt(packageId, 10) : null)
  }

  const handlePanelConfirmationChange = (confirmation: string) => {
    if (!panelOrder) return
    const nextForm = { ...panelForm, confirmation }
    setPanelForm(nextForm)
    if (panelOrder?.orderStatus === 'awaiting_shipment') {
      const dims = getPanelDims()
      const weightOz = getPanelWeightOz()
      if (hasCompleteDims(dims) && weightOz > 0) {
        void refreshPanelBestRate({
          order: panelOrder,
          dims,
          weightOz,
          confirmation,
          panelForm: nextForm,
          silent: true,
        })
      }
    }
  }

  const handlePanelInsuranceChange = (insurance: string) => {
    if (!panelOrder) return
    const nextForm = { ...panelForm, insurance }
    setPanelForm(nextForm)
    if (panelOrder?.orderStatus === 'awaiting_shipment') {
      const dims = getPanelDims()
      const weightOz = getPanelWeightOz()
      if (hasCompleteDims(dims) && weightOz > 0) {
        void refreshPanelBestRate({ order: panelOrder, dims, weightOz, panelForm: nextForm, silent: true })
      }
    }
  }

  const handlePanelInsuranceValueChange = (insuranceValue: string) => {
    if (!panelOrder) return
    const nextForm = { ...panelForm, insuranceValue }
    setPanelForm(nextForm)
    if (panelOrder?.orderStatus === 'awaiting_shipment') {
      const dims = getPanelDims()
      const weightOz = getPanelWeightOz()
      if (hasCompleteDims(dims) && weightOz > 0) {
        void refreshPanelBestRate({ order: panelOrder, dims, weightOz, panelForm: nextForm, silent: true })
      }
    }
  }

  // PS-166/PS-306 (Wave 5): thin wrapper. The closure-dependent derivations
  // (auto-best-rate order, service-option catalog, resolved dims, shipping-hold
  // verdict) are computed HERE from component state and passed as already-computed
  // props; the leaf stays presentational and recomputes only pure values.
  const renderSinglePanel = () => {
    if (!panelOrder) return buildEmptyPanel(onHideEmptyPanelChange ? () => onHideEmptyPanelChange(true) : undefined)

    const panelDisplayOrder = getOrderWithAutoBestRate(panelOrder)
    const panelFormDims = getPanelDims()
    const selectedPanelPackage = packages.find((candidate) => getPackageIdentifier(candidate) === panelForm.packageId)
    const dims = hasCompleteDims(panelFormDims)
      ? panelFormDims
      : getPackageDims(selectedPanelPackage) ?? getDimensions(panelOrder, panelDetail)
    const serviceOptions = getServiceOptionsForAccount(panelForm.shipAccountId)
    // PS-128/PS-129: shipping hold (cancelled upstream / externally shipped). Backend
    // hard-blocks; this gates the panel actions + shows the reason.
    const panelHold = orderShippingHold(panelDetail ?? panelOrder)

    return (
      <OrdersDetailSidePanel
        panelOrder={panelOrder}
        panelDetail={panelDetail}
        panelDisplayOrder={panelDisplayOrder}
        orderedFilteredOrders={orderedFilteredOrders}
        panelForm={panelForm}
        setPanelForm={setPanelForm}
        panelRatePreview={panelRatePreview}
        packages={packages}
        shippingAccounts={shippingAccounts}
        locations={locations}
        serviceOptions={serviceOptions}
        dims={dims}
        panelHold={panelHold}
        collapsedSections={collapsedSections}
        selectedOrderIds={selectedOrderIds}
        panelRateLoading={panelRateLoading}
        singleActionBusy={singleActionBusy}
        shipmentDetailsSaving={shipmentDetailsSaving}
        activeOrderLoading={activeOrderLoading}
        activeOrderError={activeOrderError}
        batchMenuOpen={batchMenuOpen}
        printMenuOpen={printMenuOpen}
        extShipMenuOpen={extShipMenuOpen}
        extShipNotifyCustomer={extShipNotifyCustomer}
        extShipNotifyMarketplace={extShipNotifyMarketplace}
        extShipTracking={extShipTracking}
        extShipBusy={extShipBusy}
        dimsUserEditedRef={dimsUserEditedRef}
        setBatchMenuOpen={setBatchMenuOpen}
        setPrintMenuOpen={setPrintMenuOpen}
        setExtShipMenuOpen={setExtShipMenuOpen}
        setExtShipNotifyCustomer={setExtShipNotifyCustomer}
        setExtShipNotifyMarketplace={setExtShipNotifyMarketplace}
        setExtShipTracking={setExtShipTracking}
        lockstepPanelDims={lockstepPanelDims}
        onNavigateView={onNavigateView}
        onHideEmptyPanelChange={onHideEmptyPanelChange}
        onShipAccountChange={handlePanelShipAccountChange}
        onPackageChange={handlePanelPackageChange}
        onConfirmationChange={handlePanelConfirmationChange}
        onInsuranceChange={handlePanelInsuranceChange}
        onInsuranceValueChange={handlePanelInsuranceValueChange}
        onCreateOrQueueLabel={createOrQueueLabel}
        onCreateOrQueueShopifyLabel={createOrQueueShopifyLabel}
        shopifyLabelPurchase={{
          visible: isShopifySourcedOrder(panelOrder, panelDetail),
          disabledReason: panelHold?.blocked ? panelHold.reason : null,
        }}
        onRecalculateBestRate={recalculateBestRate}
        onSaveShipmentDetails={saveShipmentDetails}
        onReprintLabel={reprintLabel}
        onQueueExistingLabels={queueExistingLabels}
        onOpenRateBrowser={openRateBrowser}
        onOpenVoidConfirm={openVoidConfirm}
        onOpenOrderDetails={openOrderDetails}
        onCloseSinglePanel={closeSinglePanel}
        onToggleSection={toggleSection}
        onToggleResidential={toggleResidential}
        onEditRecipient={openRecipientEditor}
        onSaveSkuDefaults={saveSkuDefaults}
        onMarkOrderShippedExternal={markOrderShippedExternal}
        onUpdateSelection={updateSelection}
      />
    )
  }

  return (
    <>
      <div id="view-orders">
        {/* PS-166/PS-306/PS-258 (Wave 4): the filter/batch/export toolbar
            (the `<div id="filterbar">` block) renders from OrdersFilterToolbar
            with byte-identical markup. PRESENTATIONAL — all async handlers
            (CSV export, recalculate, picklist, select-all-matching, column-pref
            persistence) stay PARENT-OWNED here and are threaded down as on-prefixed
            callbacks; the new file holds no apiClient/batch/persistence (PS-306).
            The table net is test:master:all-safe (toolbar is outside #ordersTable). */}
        <OrdersFilterToolbar
          searchQuery={searchQuery}
          onSearchQueryChange={onSearchQueryChange}
          dateRange={dateRange}
          onOpenNewOrder={() => setNewOrderOpen(true)}
          dateControls={{
            dateFilter,
            onDateFilterChange,
            customDateFrom,
            onCustomDateFromChange: setCustomDateFrom,
            customDateTo,
            onCustomDateToChange: setCustomDateTo,
          }}
          columnMenu={{
            columnMenuOpen,
            onToggleColumnMenu: () => setColumnMenuOpen((open) => !open),
            columnMenuPos,
            columnMenuRef,
            resolvedColumnPrefs,
            dropdownDragColumnKey,
            dropdownDragOverColumnKey,
            onDropdownDragStart: handleDropdownDragStart,
            onDropdownDragOver: handleDropdownDragOver,
            onDropdownDrop: handleDropdownDrop,
            onDropdownDragEnd: finishDropdownDrag,
            saveColumnPrefsToServer,
            buildSavedColumnPrefs,
          }}
          batchControls={{
            isReadOnly,
            visibleOrderIds,
            allVisibleSelected,
            someVisibleSelected,
            selectAllCheckboxRef,
            onToggleVisibleSelection: toggleVisibleSelection,
            visibleSelectedCount,
            total,
            selectingAllMatching,
            onSelectAllMatchingOrders: selectAllMatchingOrders,
            allMatchingSelection,
            selectionScopeKey,
            currentStatus,
            onStartBatchRecalculateBestRates: startBatchRecalculateBestRates,
            batchRecalculateBusy,
            selectedOrderIds,
            onRecalculateAll: handleRecalculateAll,
            onFullLiveRecalculateAll: handleFullLiveRecalculateAll,
            recalcAllJobId,
            recalcAllSummary,
            batchRecalculateProgress,
            onToggleSkuSort: toggleSkuSort,
            skuSortActive,
            onPrintPicklist: printPicklist,
          }}
          exportControls={{
            tableDensity,
            onTableDensityChange: setTableDensity,
            currentStatus,
            queueToolbarProgress,
            csvExporting,
            onExportCsv: handleExportCsv,
          }}
        />

        {/* PS-166 (Wave 3, JSX-safe): the daily-stats strip renders from
            OrdersDailyStrip with byte-identical markup (the whole
            <AnimatePresence> moved together to preserve its motion.div's
            enter/exit). All daily-stats state/effects/rollover stay here. */}
        <OrdersDailyStrip
          shouldShowDailyStrip={shouldShowDailyStrip}
          dailyStatsForStrip={dailyStats}
          dailyStripProgress={dailyStripProgress}
          dailyStatsFromLabel={dailyStatsFromLabel}
          dailyStatsToLabel={dailyStatsToLabel}
          dailyStatsLoadingWithoutData={dailyStatsLoadingWithoutData}
          dailyStatsRefreshFailedWithData={dailyStatsRefreshFailedWithData}
          dailyStatsErroredWithoutData={dailyStatsErroredWithoutData}
          dailyStatsError={dailyStatsError}
          loadDailyStats={loadDailyStats}
        />

        <div className="content-split relative">
          <div className="orders-section" id="ordersSection">
            {renderSelectionToolbar()}
            {/* PS-166/PS-306/PS-258 (Wave 3): the loading / error / empty-state
                framing around the orders table was extracted VERBATIM into
                <OrdersResultsShell>. It owns the .orders-wrap wrapper, the
                #loadingState skeleton, the AlertTriangle + Retry error block,
                and the embedded <OrdersResultsEmptyState> — all PRESENTATIONAL.
                PS-166 (Wave 6): the <table id="ordersTable"> itself was then
                extracted VERBATIM into <OrdersTable> and is passed in here as
                the shell's children (the table slot), at the exact position it
                sat before, so #ordersTable/#ordersBody/#tableHead stay
                byte-identical (test:orders-dom-parity:browser proves no drift).
                All data state stays in OrdersView; onRetry delegates to
                refetchOrders. */}
            <OrdersResultsShell
              loading={loading}
              error={error}
              onRetry={refetchOrders}
              ordersSearching={ordersSearching}
              hasNoFilteredOrders={orderedFilteredOrders.length === 0}
              searchQuery={searchQuery}
              isGlobalSearchActive={isGlobalSearchActive}
            >
              {!loading && !error && orderedFilteredOrders.length > 0 ? (
                <OrdersTable
                  visibleColumns={visibleColumns}
                  tableWidth={tableWidth}
                  tableDensity={tableDensity}
                  sortState={sortState}
                  dragColumnKey={dragColumnKey}
                  dragOverColumnKey={dragOverColumnKey}
                  resizingColumnKey={resizingColumnKey}
                  handleHeaderClick={handleHeaderClick}
                  handleHeaderKeyDown={handleHeaderKeyDown}
                  handleHeaderDragStart={handleHeaderDragStart}
                  handleHeaderDragOver={handleHeaderDragOver}
                  handleHeaderDrop={handleHeaderDrop}
                  finishHeaderDrag={finishHeaderDrag}
                  startColumnResize={startColumnResize}
                  orderedFilteredOrders={orderedFilteredOrders}
                  skuSortActive={skuSortActive}
                  skuOrderGroups={skuOrderGroups}
                  orderDetailsById={orderDetailsById}
                  selectedIdSet={selectedIdSet}
                  panelOrderId={panelOrderId}
                  transitionalShippedIds={transitionalShippedIds}
                  isReadOnly={isReadOnly}
                  toggleSkuGroupSelection={toggleSkuGroupSelection}
                  openOrderDetails={openOrderDetails}
                  openShipStationOrder={openShipStationOrder}
                  updateSelection={updateSelection}
                  copyText={copyText}
                  showToast={showToast}
                  renderCell={renderTableCell}
                />
              ) : null}
            </OrdersResultsShell>
          </div>

          {/* Right-side detail panel — drawer-style hide/show.
              Hidden when: pref is true AND nothing is selected.
              Reappears: when row clicked OR batch selection grows ≥ 2.
              When hidden, a vertical "Show panel" tab on the right edge
              lets the user reopen it without going to the topbar toggle. */}
          {hideEmptyPanel && panelOrderId == null && selectedOrderIds.length < 2 ? (
            // Vertical edge tab — small persistent reopen control on the
            // right edge of the orders area. Tailwind-only; the rotated
            // text reads bottom-to-top, click to flip the pref back to
            // "show". Mirrors the close-button in the panel header so
            // users have a visible way to undo their hide action.
            onHideEmptyPanelChange ? (
              <button
                type="button"
                onClick={() => onHideEmptyPanelChange(false)}
                aria-label="Show order detail panel"
                title="Show order detail panel"
                className="absolute top-1/2 right-0 -translate-y-1/2 z-10 inline-flex items-center justify-center px-1.5 py-3 rounded-l-lg bg-surface ring-1 ring-line border-r-0 text-ink-3 hover:text-brand hover:bg-brand/5 hover:ring-brand/30 transition-all duration-150 shadow-sm group"
              >
                <span className="flex flex-col items-center gap-1 [writing-mode:vertical-rl] rotate-180 text-[10.5px] font-semibold uppercase tracking-[0.08em] select-none">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="rotate-90 group-hover:-translate-x-0.5 transition-transform" aria-hidden="true">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Show panel
                </span>
              </button>
            ) : null
          ) : (
            <div className="order-panel" id="orderPanel">
              <div className="panel-inner" id="panelInner">
                {activeOrderId == null && selectedOrderIds.length >= 2 ? (
                  <OrdersBatchPanel
                    isReadOnly={isReadOnly}
                    orders={orders}
                    selectedIdSet={selectedIdSet}
                    selectedOrderIds={selectedOrderIds}
                    currentStatus={currentStatus}
                    clearSelection={clearSelection}
                    batchExtShipMenuOpen={batchExtShipMenuOpen}
                    setBatchExtShipMenuOpen={setBatchExtShipMenuOpen}
                    extShipBusy={extShipBusy}
                    extShipNotifyCustomer={extShipNotifyCustomer}
                    setExtShipNotifyCustomer={setExtShipNotifyCustomer}
                    extShipNotifyMarketplace={extShipNotifyMarketplace}
                    setExtShipNotifyMarketplace={setExtShipNotifyMarketplace}
                    handleBatchMarkAsShipped={handleBatchMarkAsShipped}
                    copiedAll={copiedAll}
                    setCopiedAll={setCopiedAll}
                    copiedOrderNum={copiedOrderNum}
                    setCopiedOrderNum={setCopiedOrderNum}
                    handleBatchAction={handleBatchAction}
                    batchBusy={batchBusy}
                    handleCombineShipments={handleCombineShipments}
                    combineBusy={combineBusy}
                    batchTestMode={batchTestMode}
                    setBatchTestMode={setBatchTestMode}
                    callerIsAdmin={callerIsAdmin}
                    assignBusy={assignBusy}
                    assignTo={assignTo}
                    setAssignTo={setAssignTo}
                    assignableUsers={assignableUsers}
                    handleAssignSelectedOrders={handleAssignSelectedOrders}
                  />
                ) : renderSinglePanel()}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="pagination-bar !flex !items-center !gap-2 !px-4 !py-2 !bg-white !border-t !border-line" id="paginationBar">
        <button
          className="btn btn-outline btn-sm !transition-all !duration-150 hover:!shadow-sm hover:!-translate-y-px active:!translate-y-0 active:!scale-95 disabled:!opacity-40 disabled:hover:!translate-y-0 disabled:hover:!shadow-none disabled:!cursor-not-allowed"
          type="button"
          id="prevBtn"
          disabled={currentPage <= 1}
          aria-label="Previous page"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          ← Prev
        </button>
        <span id="pageInfo" className="text-tiny text-ink-2 font-mono tabular-nums">
          Page <span className="font-bold text-ink">{pages === 0 ? 0 : currentPage}</span> <span className="text-ink-3">of</span> <span className="font-bold text-ink">{pages || 0}</span>
        </span>
        <span className="w-px h-4 bg-line-2" aria-hidden />
        <span id="totalInfo" className="text-tiny text-ink-3 font-mono tabular-nums">
          <span className="font-semibold text-ink-2">{total.toLocaleString()}{totalApproximate ? '+' : ''}</span> total
        </span>

        {/* Page-size selector — operator picks 5/20/50/100/200 rows per
            page (see ALLOWED_PAGE_SIZES above). Choice persists to
            localStorage. Sits in the pagination bar between "total"
            and "Next →" so it's visible without being in the way of
            the primary nav controls. */}
        <span className="w-px h-4 bg-line-2 ml-2" aria-hidden />
        <label className="inline-flex items-center gap-1.5 text-tiny text-ink-3 font-medium">
          <span className="hidden sm:inline">Per page:</span>
          <span className="relative inline-flex items-center">
            <select
              value={pageSize}
              onChange={(event) => updatePageSize(Number(event.target.value))}
              aria-label="Rows per page"
              className="
                appearance-none cursor-pointer
                h-7 pl-2.5 pr-6
                rounded-md
                bg-surface ring-1 ring-line
                text-[12px] font-semibold text-ink-2 tabular-nums
                hover:text-ink hover:ring-line-2
                focus:bg-surface focus:ring-2 focus:ring-brand/40
                focus:outline-none
                transition-all duration-150
              "
            >
              {ALLOWED_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
            <span
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-3 text-[8px] pointer-events-none"
              aria-hidden
            >▼</span>
          </span>
        </label>

        <button
          className="btn btn-outline btn-sm !ml-auto !transition-all !duration-150 hover:!shadow-sm hover:!-translate-y-px active:!translate-y-0 active:!scale-95 disabled:!opacity-40 disabled:hover:!translate-y-0 disabled:hover:!shadow-none disabled:!cursor-not-allowed"
          type="button"
          id="nextBtn"
          disabled={pages === 0 || currentPage >= pages}
          aria-label="Next page"
          onClick={() => setPage((current) => Math.min(pages, current + 1))}
        >
          Next →
        </button>
      </div>

      {/* PS-178 (Phase 6, part 3): the drawer JSX moved VERBATIM to
          ./OrdersPrintQueueDrawer — render-only; all queue state, derived
          lists, and handlers stay here and flow down as props. */}
      {/* PS-166/PS-306/PS-258 (Wave 1): the recipient-editor modal JSX moved VERBATIM to
          ./OrdersRecipientEditorModal — render-only; recipientDraft/saving state + the
          recipientInput closure stay here and flow down as props (renderRecipientInput). */}
      <OrdersRecipientEditorModal
        isOpen={recipientEditorOpen}
        panelOrder={panelOrder}
        isSaving={recipientEditorSaving}
        onClose={() => setRecipientEditorOpen(false)}
        onSave={() => void saveRecipientOverride()}
        renderRecipientInput={recipientInput}
      />

      {queueOpen ? (
        <Suspense fallback={null}>
          <OrdersPrintQueueDrawer
            queueClients={queueClients}
            pqClientFilter={pqClientFilter}
            setPqClientFilter={setPqClientFilter}
            queueClientLabel={queueClientLabel}
            queueClientId={queueClientId}
            queueHistoryVisible={queueHistoryVisible}
            setQueueHistoryVisible={setQueueHistoryVisible}
            setQueueOpen={setQueueOpen}
            pqSearch={pqSearch}
            setPqSearch={setPqSearch}
            pqHistoryAsc={pqHistoryAsc}
            setPqHistoryAsc={setPqHistoryAsc}
            queueCount={queueCount}
            queuedEntries={queuedEntries}
            visibleQueueGroups={visibleQueueGroups}
            queueHasVisibleEntries={queueHasVisibleEntries}
            queueLoading={queueLoading}
            pqSearchLower={pqSearchLower}
            printedEntries={printedEntries}
            visiblePrintedEntries={visiblePrintedEntries}
            unprintedQueueCount={unprintedQueueCount}
            queueConfirmPrintedReady={queueConfirmPrintedReady}
            queuePrintMessage={queuePrintMessage}
            queuePrintProgress={queuePrintProgress}
            queuePrintInFlight={queuePrintInFlight}
            hydrateQueue={hydrateQueue}
            showToast={showToast as (message: string, type?: string) => void}
            printQueueEntries={printQueueEntries}
            confirmQueueEntriesPrinted={confirmQueueEntriesPrinted}
            openDetailDrawer={openDetailDrawer}
          />
        </Suspense>
      ) : null}

      {detailDrawerOrderId != null ? (
        <Suspense fallback={null}>
          {/* Per user override unlock shipped data on 2026-05-25: do not force the active sidebar route as the detail status. */}
          <OrderDetailDrawer
            orderId={detailDrawerOrderId}
            presentation={detailDrawerFromQueue ? 'modal' : 'drawer'}
            closeLabel={detailDrawerFromQueue ? 'Back' : undefined}
            closeTitle={detailDrawerFromQueue ? 'Back to print queue' : undefined}
            onClose={closeDetailDrawer}
          />
        </Suspense>
      ) : null}

      {trackingModal != null ? (
        <Suspense fallback={null}>
          <TrackingModal
            open
            trackingNumber={trackingModal.tracking}
            carrierCode={trackingModal.carrierCode}
            onClose={() => setTrackingModal(null)}
          />
        </Suspense>
      ) : null}

      {/* Manual order creation modal. Creates a local awaiting-shipment
          order under the Manual Orders sandbox client. */}
      {newOrderOpen ? (
        <Suspense fallback={null}>
          <NewOrderModal
            open={newOrderOpen}
            locations={locations}
            onClose={() => setNewOrderOpen(false)}
            onSave={async (payload: NewOrderPayload) => {
              const result = await apiClient.createManualOrder(payload as unknown as Record<string, unknown>)
              const orderNumber = result?.data?.order?.orderNumber ?? payload.orderNumber
              setNewOrderOpen(false)
              showToast(`Manual order created${orderNumber ? `: ${orderNumber}` : ''}`, 'success')
              await refetchOrders()
              window.dispatchEvent(new Event('prepship:client-active-changed'))
              return true
            }}
          />
        </Suspense>
      ) : null}

      {rateBrowserOpen ? (
        <Suspense fallback={null}>
          <RateBrowserModal
            open={rateBrowserOpen}
            order={panelOrder}
            locations={locations}
            packages={packages as any}
            shippingAccounts={panelOrder && isTestOrder(panelOrder, panelDetail) ? buildTestRateBrowserAccounts() : shippingAccounts}
            testMode={Boolean(panelOrder && isTestOrder(panelOrder, panelDetail))}
            initialDims={{
              length: Number.parseFloat(panelForm.length) || 0,
              width: Number.parseFloat(panelForm.width) || 0,
              height: Number.parseFloat(panelForm.height) || 0,
            }}
            initialWeight={{
              lb: Number.parseFloat(panelForm.weightLb) || 0,
              oz: Number.parseFloat(panelForm.weightOz) || 0,
            }}
            initialConfirmation={panelForm.confirmation}
            initialInsurance={panelForm.insurance}
            initialInsuranceValue={panelForm.insuranceValue}
            onClose={() => { void closeRateBrowserAfterPersist() }}
            onBestRateResolved={(best) => {
              if (!panelOrderId) return
              if (panelOrder && isTestOrder(panelOrder, panelDetail)) {
                const testRate = buildTestMockRate(best)
                setPanelRatePreview([testRate])
                const autoRequest = panelOrder ? getAutoBestRateRequest(panelOrder) : null
                if (autoRequest) {
                  setAutoBestRateEntries((current) => ({
                    ...current,
                    [panelOrderId]: { key: autoRequest.key, rate: testRate },
                  }))
                }
                setPanelForm((current) => ({
                  ...current,
                  shipAccountId: TEST_CARRIER_CODE,
                  serviceCode: testRate.serviceCode,
                }))
                const dims = best.dims
                trackAppliedRatePersist(
                  appliedRatePersistsRef.current,
                  panelOrderId,
                  Promise.resolve()
                    .then(() => persistAppliedRateForOrder(panelOrderId, testRate, {
                      fallbackDims: dims ?? getPanelDims(),
                      fallbackWeightOz: getPanelWeightOz() || getOrderWeightOz(panelOrder, panelDetail),
                      refetch: true,
                    }))
                    .catch((error) => {
                      showToast(error instanceof Error ? error.message : 'Failed to save test mock rate', 'error')
                    }),
                )
                return
              }
              setPanelRatePreview([best])
              const autoRequest = panelOrder ? getAutoBestRateRequest(panelOrder) : null
              if (autoRequest) {
                setAutoBestRateEntries((current) => ({
                  ...current,
                  [panelOrderId]: { key: autoRequest.key, rate: best },
                }))
              }
              const shippingProviderId = toNumberValue(best.shippingProviderId)
              const serviceCode = toStringValue(best.serviceCode)
              if (shippingProviderId != null && serviceCode) {
                setPanelForm((current) => ({
                  ...current,
                  shipAccountId: String(shippingProviderId),
                  serviceCode,
                  confirmation: normalizeConfirmationForRates(best.confirmation ?? current.confirmation),
                  insurance: toStringValue(best.insuranceProvider) ?? current.insurance,
                  insuranceValue: best.insuredValue != null ? String(best.insuredValue) : current.insuranceValue,
                  weightLb: best.weight ? String(best.weight.lb ?? current.weightLb) : current.weightLb,
                  weightOz: best.weight ? String(best.weight.oz ?? current.weightOz) : current.weightOz,
                  length: best.dims ? String(best.dims.length ?? current.length) : current.length,
                  width: best.dims ? String(best.dims.width ?? current.width) : current.width,
                  height: best.dims ? String(best.dims.height ?? current.height) : current.height,
                }))
              }
              const dims = best.dims
              trackAppliedRatePersist(
                appliedRatePersistsRef.current,
                panelOrderId,
                Promise.resolve()
                  .then(() => persistAppliedRateForOrder(panelOrderId, best, {
                  fallbackDims: dims ?? getPanelDims(),
                  fallbackWeightOz: getPanelWeightOz() || getOrderWeightOz(panelOrder, panelDetail),
                  // PS-083 follow-up: stamp the browse-resolved best rate with the
                  // order's request metadata (fingerprint + freshness) exactly like
                  // applyRateSelection — otherwise the saved rate fails the reload
                  // freshness gate (savedRateIsFreshAndComplete) and the row reverts
                  // to the auto/recalc value on refresh ("browse rate not saved").
                  ...(autoRequest
                    ? {
                        request: autoRequest,
                        metadata: {
                          isComplete: best.isComplete === true,
                          rateCount: toNumberValue(best.rateCount) ?? 1,
                          matchType: 'browse',
                        },
                      }
                    : {}),
                  refetch: true,
                }))
                  .catch((error) => {
                    showToast(error instanceof Error ? error.message : 'Failed to save best rate', 'error')
                  }),
              )
            }}
            onApplyRate={(applied) => {
              // Push rate back into the panel using the existing applyRateSelection
              // path. The v2-style modal also returns weight + dims; sync those to
              // the panel form so /labels/create sees the user's final numbers.
              if (applied.weight) {
                setPanelForm((current) => ({
                  ...current,
                  confirmation: normalizeConfirmationForRates(applied.confirmation ?? current.confirmation),
                  insurance: toStringValue(applied.insuranceProvider) ?? current.insurance,
                  insuranceValue: applied.insuredValue != null ? String(applied.insuredValue) : current.insuranceValue,
                  weightLb: String(applied.weight?.lb ?? current.weightLb),
                  weightOz: String(applied.weight?.oz ?? current.weightOz),
                }))
              }
              if (applied.dims) {
                setPanelForm((current) => ({
                  ...current,
                  confirmation: normalizeConfirmationForRates(applied.confirmation ?? current.confirmation),
                  insurance: toStringValue(applied.insuranceProvider) ?? current.insurance,
                  insuranceValue: applied.insuredValue != null ? String(applied.insuredValue) : current.insuranceValue,
                  length: String(applied.dims?.length ?? current.length),
                  width: String(applied.dims?.width ?? current.width),
                  height: String(applied.dims?.height ?? current.height),
                }))
              }
              applyRateSelection(applied)
            }}
          />
        </Suspense>
      ) : null}

      {/* PS-219 (per user override unlock shipped data on 2026-06-13): operator
          Void Label confirmation. Danger tone; backdrop/Escape are suppressed
          while the void is in flight so it can't be abandoned mid-request. */}
      <ConfirmModal
        open={!!voidConfirm}
        tone="danger"
        loading={voidBusy}
        title="Void this label?"
        description={
          voidConfirm ? (
            <div className="space-y-1">
              <div>
                Order <strong>{voidConfirm.order.orderNumber ?? voidConfirm.order.orderId}</strong>
              </div>
              {voidConfirm.voidability?.providerLabel ? (
                <div>
                  {[
                    voidConfirm.voidability.providerLabel.carrier,
                    voidConfirm.voidability.providerLabel.service,
                    voidConfirm.voidability.providerLabel.accountLabel,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              ) : null}
              {voidConfirm.voidability?.providerLabel?.trackingNumber ? (
                <div className="font-mono text-[11px] text-ink-2">
                  {voidConfirm.voidability.providerLabel.trackingNumber}
                </div>
              ) : null}
              <div className="mt-1.5 text-ink-3">
                A postage refund is requested at the carrier; timing varies. The order
                resets to Awaiting Shipment only AFTER the provider confirms the void —
                if the provider fails, nothing changes locally.
              </div>
            </div>
          ) : null
        }
        confirmLabel="Void label"
        cancelLabel="Keep label"
        onConfirm={() => void confirmVoidLabel()}
        onCancel={() => {
          if (!voidBusy) setVoidConfirm(null)
        }}
      />
    </>
  )
}
