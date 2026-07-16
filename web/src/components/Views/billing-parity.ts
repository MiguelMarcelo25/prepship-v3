
// PS-257: the billing DTOs below are phantom names that were imported from
// types/api but never actually exported there. They're defined locally (and
// exported) here — billing-parity is the most-shared billing module — so the
// sibling billing components can import them from one place. Shapes are index-
// signature records (matching the AnyRecord convention in types/api.ts) so the
// mixed camelCase/snake_case field reads across the billing pipeline type-check
// without changing any runtime behavior.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BillingAnyRecord = Record<string, any>

export type BillingConfigDto = BillingAnyRecord & {
  clientId: number
  clientName?: string | null
  houseAccountEnabled?: boolean | null
  shippingMarginPolicyMode?: 'pass_through' | 'next_best_customer_rate' | string | null
  hugrabShippingRateOverrideEnabled?: boolean | null
  hugrabShippingRateOverrideThreshold?: number | string | null
  hugrabShippingRateOverrideAmount?: number | string | null
}
export type BillingSummaryDto = BillingAnyRecord & {
  clientId: number
  clientName?: string | null
}
export type BillingDetailDto = BillingAnyRecord
export type BillingPackagePriceDto = BillingAnyRecord & {
  packageId: number
  price: number
  name?: string | null
  length?: number | string | null
  width?: number | string | null
  height?: number | string | null
  dimsText?: string | null
  dims_text?: string | null
  unitCost?: number | string | null
  unit_cost?: number | string | null
  ourCost?: number | string | null
  our_cost?: number | string | null
  charge?: number | string | null
  usageCount?: number | null
  usage_count?: number | null
  usageSources?: string[] | null
  usage_sources?: string[] | null
  isCustom?: boolean
  is_custom?: boolean
}
export type BillingReferenceRateFetchStatusDto = BillingAnyRecord & {
  done: number
  total: number
  errors?: number
}
export type FetchBillingReferenceRatesResult = BillingAnyRecord & {
  ok?: boolean
  message?: string
  total?: number
  orders?: number
  queued?: number
}
export type BackfillBillingReferenceRatesResult = BillingAnyRecord & {
  message?: string
  filled?: number
  missing?: number
}
export type UpdateBillingConfigInput = {
  pickPackFee: number
  pickPackMaxUnits: number
  additionalUnitFee: number
  packageCostMarkup: number
  shippingMarkupPct: number
  shippingMarkupFlat: number
  hugrabShippingRateOverrideEnabled: boolean
  hugrabShippingRateOverrideThreshold: number
  hugrabShippingRateOverrideAmount: number
  storageFeePerCuFt: number
  billingMode: string
  active: boolean
}

export type BillingPresetId = 'all' | 'this_month' | 'last_month' | 'last_30' | 'last_90'

export interface BillingConfigDraft {
  pickPackFee: string
  pickPackMaxUnits: string
  additionalUnitFee: string
  packageCostMarkup: string
  shippingMarkupPct: string
  shippingMarkupFlat: string
  hugrabShippingRateOverrideEnabled: boolean
  hugrabShippingRateOverrideThreshold: string
  hugrabShippingRateOverrideAmount: string
  storageFeePerCuFt: string
  billingMode: string
  active: boolean
}

export type BillingDetailColumnId =
  | 'actions'
  | 'orderNumber'
  | 'billingStatus'
  | 'shipDate'
  | 'carrierNickname'
  | 'itemNames'
  | 'itemSkus'
  | 'totalQty'
  | 'pickpack'
  | 'additional'
  | 'packageCost'
  | 'packageName'
  | 'selectedRate'
  | 'upsss'
  | 'uspsss'
  | 'shipping'
  | 'total'
  | 'margin'

export interface BillingDetailColumn {
  id: BillingDetailColumnId
  label: string
  align: 'left' | 'right' | 'center'
  always: boolean
}

export interface BillingSummaryTotals {
  orders: number
  pickPack: number
  additional: number
  pickPackFee: number
  package: number
  storage: number
  shipping: number
  fulfillmentFee: number
  grand: number
}

export interface BillingDetailMetrics {
  pickPack: number
  additional: number
  pickPackFee: number
  packageCost: number
  shipping: number
  storage: number
  fulfillmentFee: number
  total: number
  ourCost: number
  margin: number
  ssCharged: boolean
  chargedRate: 'selectedRate' | 'upsss' | 'uspsss' | null
}

export interface BillingPackagePriceRow {
  packageId: number
  name: string
  dimsText: string
  length: number | null
  width: number | null
  height: number | null
  ourCost: number | null
  charge: number
  isCustom: boolean
  marginPct: number | null
  marginColor: string | null
  usageCount: number
  usageSources: string[]
}

export const BILLING_DETAIL_COLUMNS: BillingDetailColumn[] = [
  { id: 'actions', label: 'Actions', align: 'center', always: true },
  { id: 'orderNumber', label: 'Order #', align: 'left', always: true },
  { id: 'billingStatus', label: 'Status', align: 'left', always: false },
  { id: 'shipDate', label: 'Billing Date', align: 'left', always: false },
  { id: 'carrierNickname', label: 'Carrier', align: 'left', always: false },
  { id: 'itemNames', label: 'Item Name', align: 'left', always: false },
  { id: 'itemSkus', label: 'SKU', align: 'left', always: false },
  { id: 'totalQty', label: 'Qty', align: 'right', always: false },
  { id: 'pickpack', label: 'Pick & Pack', align: 'right', always: false },
  { id: 'additional', label: 'Addl Units', align: 'right', always: false },
  { id: 'packageCost', label: 'Box Cost', align: 'right', always: false },
  { id: 'packageName', label: 'Box Size', align: 'center', always: false },
  { id: 'selectedRate', label: 'Selected Rate', align: 'right', always: false },
  { id: 'upsss', label: 'UPS SS', align: 'right', always: false },
  { id: 'uspsss', label: 'USPS SS', align: 'right', always: false },
  { id: 'shipping', label: 'Shipping', align: 'right', always: false },
  { id: 'total', label: 'Fulfillment Fee', align: 'right', always: true },
  { id: 'margin', label: 'Shipping Margin', align: 'right', always: false },
]

// v6 (2026-07-06): defaults add backend-owned Billing Status after Order #.
// v4 (2026-05-27): defaults now expose every billing detail column plus
// row actions so operators can audit/edit a full invoice line at once.
// Bumping the storage key resets returning users to the new default
// order; if they had custom toggles, they re-pick them once.
const BILLING_DETAIL_COLS_KEY = 'billing_detail_cols_v7'

const DEFAULT_BILLING_DETAIL_COLUMN_IDS: BillingDetailColumnId[] = [
  'actions',
  'orderNumber',
  'billingStatus',
  'shipDate',
  'carrierNickname',
  'itemNames',
  'itemSkus',
  'totalQty',
  'pickpack',
  'additional',
  'packageCost',
  'packageName',
  'selectedRate',
  'upsss',
  'uspsss',
  'shipping',
  'total',
  'margin',
]

function parseNumber(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function formatBillingQuantity(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0'
  const text = String(value).trim()
  if (!text) return '0'
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return text
  if (Number.isInteger(parsed)) return String(parsed)
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

export function billingDetailQtyDisplay(row: BillingDetailDto): string {
  return formatBillingQuantity(row.displayQty ?? row.totalQty ?? row.qty ?? 0)
}

export function billingDetailQtySortValue(row: BillingDetailDto): number | string {
  const parsed = Number(row.totalQty ?? row.qty ?? row.displayQty)
  return Number.isFinite(parsed) ? parsed : billingDetailQtyDisplay(row)
}

function moneyNumber(value: number) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2))
}

// PS-369: calculateBillingPickPackFee / calculateBillingFulfillmentFee are DELETED.
// They duplicated the backend fee math (src/services/billing.ts generator) in React;
// the backend emits pickPackFeeTotal / fulfillmentFeeTotal on every summary and
// detail row (typed since PS-368), so the FE displays them verbatim.

export function createBillingConfigDraft(config: BillingConfigDto): BillingConfigDraft {
  // Accept either the v4 camelCase (`billingMode`, `pickPackMaxUnits`) or
  // legacy snake_case (`billing_mode`) shapes on the incoming DTO.
  const c = config as any
  const isHugrabClient = String(c.clientName ?? '').trim().toUpperCase() === 'HUGRAB'
  return {
    pickPackFee: Number(c.pickPackFee ?? 0).toFixed(2),
    pickPackMaxUnits: String(c.pickPackMaxUnits ?? 1),
    additionalUnitFee: Number(c.additionalUnitFee ?? 0).toFixed(2),
    packageCostMarkup: Number(c.packageCostMarkup ?? 0).toFixed(1),
    shippingMarkupPct: Number(c.shippingMarkupPct ?? 0).toFixed(1),
    shippingMarkupFlat: Number(c.shippingMarkupFlat ?? 0).toFixed(2),
    hugrabShippingRateOverrideEnabled:
      c.hugrabShippingRateOverrideEnabled == null
        ? isHugrabClient
        : c.hugrabShippingRateOverrideEnabled !== false,
    hugrabShippingRateOverrideThreshold: Number(c.hugrabShippingRateOverrideThreshold ?? 6).toFixed(2),
    hugrabShippingRateOverrideAmount: Number(c.hugrabShippingRateOverrideAmount ?? 7.73).toFixed(2),
    storageFeePerCuFt: Number(c.storageFeePerCuFt ?? 0).toFixed(2),
    billingMode: c.billingMode ?? c.billing_mode ?? 'per_shipment',
    active: c.active === false ? false : true,
  }
}

export function createBillingConfigDraftMap(configs: BillingConfigDto[]) {
  return Object.fromEntries(configs.map((config) => [config.clientId, createBillingConfigDraft(config)]))
}

export function buildBillingConfigInput(draft: BillingConfigDraft): UpdateBillingConfigInput {
  const parsedMax = Number.parseInt(draft.pickPackMaxUnits ?? '1', 10)
  return {
    pickPackFee: parseNumber(draft.pickPackFee),
    pickPackMaxUnits: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 1,
    additionalUnitFee: parseNumber(draft.additionalUnitFee),
    packageCostMarkup: parseNumber(draft.packageCostMarkup),
    shippingMarkupPct: parseNumber(draft.shippingMarkupPct),
    shippingMarkupFlat: parseNumber(draft.shippingMarkupFlat),
    hugrabShippingRateOverrideEnabled: draft.hugrabShippingRateOverrideEnabled !== false,
    hugrabShippingRateOverrideThreshold: parseNumber(draft.hugrabShippingRateOverrideThreshold || '6'),
    hugrabShippingRateOverrideAmount: parseNumber(draft.hugrabShippingRateOverrideAmount || '7.73'),
    storageFeePerCuFt: parseNumber(draft.storageFeePerCuFt),
    billingMode: draft.billingMode || 'per_shipment',
    active: draft.active !== false,
  } as UpdateBillingConfigInput
}

export function buildBillingSummaryTotals(rows: BillingSummaryDto[]): BillingSummaryTotals {
  return rows.reduce<BillingSummaryTotals>((totals, row) => {
    const pickPack = Number(row.pickPackTotal || 0)
    const additional = Number(row.additionalTotal || 0)
    // PS-369: display-only — the backend summary emits both fee totals on every
    // row; the FE no longer recomputes them (snake key kept as deploy-skew fallback).
    const pickPackFee = Number(row.pickPackFeeTotal ?? row.pick_pack_fee_total ?? 0)
    const shipping = Number(row.shippingTotal || 0)
    const boxFee = Number(row.packageTotal || 0)
    const storage = Number(row.storageTotal || 0)
    const fulfillmentFee = Number(row.fulfillmentFeeTotal ?? row.fulfillment_fee_total ?? 0)
    return {
      orders: totals.orders + (row.orderCount || 0),
      pickPack: totals.pickPack + pickPack,
      additional: totals.additional + additional,
      pickPackFee: totals.pickPackFee + pickPackFee,
      package: totals.package + boxFee,
      storage: totals.storage + storage,
      shipping: totals.shipping + shipping,
      fulfillmentFee: totals.fulfillmentFee + fulfillmentFee,
      grand: totals.grand + (row.grandTotal || fulfillmentFee),
    }
  }, {
    orders: 0,
    pickPack: 0,
    additional: 0,
    pickPackFee: 0,
    package: 0,
    storage: 0,
    shipping: 0,
    fulfillmentFee: 0,
    grand: 0,
  })
}

export function formatBillingMoney(value: number | null | undefined, options: { dashIfZero?: boolean } = {}) {
  if (value == null || Number.isNaN(value)) return '—'
  if (options.dashIfZero && value <= 0) return '—'
  return `$${value.toFixed(2)}`
}

const BILLING_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/

function billingDayParts(value: string | null | undefined) {
  const match = BILLING_DAY_RE.exec(String(value ?? '').trim())
  if (!match) return null
  return {
    year: match[1]!,
    month: match[2]!,
    day: match[3]!,
  }
}

// Billing ship_date is a calendar day stored at UTC midnight, not an instant.
// Display only the billing day so the UI does not invent a misleading time.
export function formatBillingShipDate(value: string | null | undefined) {
  const parts = billingDayParts(value)
  if (!parts) return value ? String(value) : '—'
  return `${Number(parts.month)}/${Number(parts.day)}/${parts.year}`
}

export function billingShipDateSortValue(value: string | null | undefined) {
  const parts = billingDayParts(value)
  if (!parts) return null
  return Number(`${parts.year}${parts.month}${parts.day}`)
}

export function getBillingDetailColumnStorageKey() {
  return BILLING_DETAIL_COLS_KEY
}

export function getDefaultBillingDetailColumnIds() {
  return [...DEFAULT_BILLING_DETAIL_COLUMN_IDS]
}

export function readBillingDetailColumnIds(storage?: Pick<Storage, 'getItem'> | null) {
  if (!storage) return getDefaultBillingDetailColumnIds()

  try {
    const raw = storage.getItem(BILLING_DETAIL_COLS_KEY)
    if (!raw) return getDefaultBillingDetailColumnIds()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return getDefaultBillingDetailColumnIds()

    const allowed = new Set(BILLING_DETAIL_COLUMNS.map((column) => column.id))
    const next = parsed.filter((value): value is BillingDetailColumnId => typeof value === 'string' && allowed.has(value as BillingDetailColumnId))
    return next.length > 0 ? next : getDefaultBillingDetailColumnIds()
  } catch {
    return getDefaultBillingDetailColumnIds()
  }
}

export function toggleBillingDetailColumnIds(columnIds: BillingDetailColumnId[], columnId: BillingDetailColumnId) {
  return columnIds.includes(columnId)
    ? columnIds.filter((value) => value !== columnId)
    : [...columnIds, columnId]
}

// Drag-to-reorder helper: pulls `fromId` out of its current slot and
// drops it before `toId`. Returning the same array (unchanged) when
// either id is missing keeps callers' useEffect-on-change idempotent.
export function reorderBillingDetailColumnIds(
  columnIds: BillingDetailColumnId[],
  fromId: BillingDetailColumnId,
  toId: BillingDetailColumnId,
): BillingDetailColumnId[] {
  if (fromId === toId) return columnIds
  const fromIndex = columnIds.indexOf(fromId)
  if (fromIndex < 0) return columnIds
  const without = columnIds.filter((value) => value !== fromId)
  const toIndex = without.indexOf(toId)
  if (toIndex < 0) return columnIds
  return [...without.slice(0, toIndex), fromId, ...without.slice(toIndex)]
}

export function getVisibleBillingDetailColumns(columnIds: BillingDetailColumnId[]) {
  // Render order = user's stored order. We iterate `columnIds` (not
  // the static BILLING_DETAIL_COLUMNS) so drag-to-reorder takes effect
  // visually. Always-on columns get auto-appended at the end if a
  // user somehow stripped them from their saved list (shouldn't
  // happen via the UI, but guards against corrupted localStorage).
  const byId = new Map<BillingDetailColumnId, BillingDetailColumn>(
    BILLING_DETAIL_COLUMNS.map((column) => [column.id, column]),
  )
  const result: BillingDetailColumn[] = []
  const seen = new Set<BillingDetailColumnId>()
  for (const id of columnIds) {
    const column = byId.get(id)
    if (column && !seen.has(id)) {
      result.push(column)
      seen.add(id)
    }
  }
  for (const column of BILLING_DETAIL_COLUMNS) {
    if (column.always && !seen.has(column.id)) {
      result.push(column)
      seen.add(column.id)
    }
  }
  return result
}

// PS-369: aggregateBillingDetailRowsByOrder is DELETED. It was the dead FE twin of the
// backend toBillingDetailOrderRows (billing-detail-row-sot.ts) — zero callers since PS-362
// moved order-row aggregation behind the API. The backend SOT is the only aggregator.


export function computeBillingDetailMetrics(detail: BillingDetailDto): BillingDetailMetrics {
  const lineType = detail.lineType ?? detail.line_type
  const lineTotal = Number(detail.totalCost ?? detail.total_cost ?? 0) || 0
  const pickPack = Number(detail.pickpackTotal ?? detail.pick_pack_total ?? (lineType === 'pick_pack' ? lineTotal : 0)) || 0
  const additional = Number(detail.additionalTotal ?? detail.additional_total ?? (lineType === 'additional_unit' ? lineTotal : 0)) || 0
  const packageCost = Number(detail.packageTotal ?? detail.package_total ?? (lineType === 'package_cost' ? lineTotal : 0)) || 0
  const shipping = Number(detail.shippingTotal ?? detail.shipping_total ?? (lineType === 'shipping' ? lineTotal : 0)) || 0
  const storage = Number(detail.storageTotal ?? detail.storage_total ?? (lineType === 'storage' ? lineTotal : 0)) || 0
  // PS-369: display-only — the backend detail row DTO (PS-368) always carries both
  // fee totals; the FE no longer recomputes them (snake key kept as deploy-skew fallback).
  const pickPackFee = Number(detail.pickPackFeeTotal ?? detail.pick_pack_fee_total ?? 0) || 0
  const fulfillmentFee = Number(detail.fulfillmentFeeTotal ?? detail.fulfillment_fee_total ?? 0) || 0
  const total = Number(detail.grandTotal ?? detail.grand_total ?? detail.total ?? 0) || fulfillmentFee
  const selectedRateCost = detail.selectedRateCost ?? detail.selected_rate_cost
  const ourCost = Number(selectedRateCost ?? 0) || 0
  const margin = shipping - ourCost
  const refUpsRate = detail.refUpsRate ?? detail.ref_ups_rate
  const refUspsRate = detail.refUspsRate ?? detail.ref_usps_rate
  const ssCharged = shipping > 0 && selectedRateCost != null && shipping > Number(selectedRateCost) + 0.01

  let chargedRate: BillingDetailMetrics['chargedRate'] = null
  if (shipping > 0) {
    const tol = 0.01
    if (selectedRateCost != null && Math.abs(shipping - Number(selectedRateCost)) <= tol) chargedRate = 'selectedRate'
    else if (refUpsRate != null && Math.abs(shipping - Number(refUpsRate)) <= tol) chargedRate = 'upsss'
    else if (refUspsRate != null && Math.abs(shipping - Number(refUspsRate)) <= tol) chargedRate = 'uspsss'
  }

  return {
    pickPack,
    additional,
    pickPackFee,
    packageCost,
    shipping,
    storage,
    fulfillmentFee,
    total,
    ourCost,
    margin,
    ssCharged,
    chargedRate,
  }
}

export function buildBillingPackagePriceRows(
  savedRows: BillingPackagePriceDto[],
  draftPrices?: Record<number, string | number>,
) {
  return savedRows
    .map<BillingPackagePriceRow>((row) => {
      const packageId = Number(row.packageId)
      const draft = draftPrices?.[packageId]
      const charge = draft != null ? parseNumber(String(draft)) : Number(row.charge ?? row.price ?? 0)
      const ourCostRaw = row.ourCost ?? row.our_cost ?? row.unitCost ?? row.unit_cost
      const ourCost = ourCostRaw != null && Number.isFinite(Number(ourCostRaw)) ? Number(ourCostRaw) : null
      const length = row.length != null && Number.isFinite(Number(row.length)) ? Number(row.length) : null
      const width = row.width != null && Number.isFinite(Number(row.width)) ? Number(row.width) : null
      const height = row.height != null && Number.isFinite(Number(row.height)) ? Number(row.height) : null
      const dimsText =
        row.dimsText ??
        row.dims_text ??
        (length != null && width != null && height != null ? `${length}x${width}x${height}"` : '-')
      const isCustom = Boolean(row.isCustom ?? row.is_custom)
      const usageSources = Array.isArray(row.usageSources)
        ? row.usageSources
        : Array.isArray(row.usage_sources)
          ? row.usage_sources
          : []
      const usageCount = Number(row.usageCount ?? row.usage_count ?? 0)

      if (ourCost == null || charge <= 0) {
        return {
          packageId,
          name: row.name ?? `Box #${packageId}`,
          dimsText,
          length,
          width,
          height,
          ourCost,
          charge,
          isCustom,
          marginPct: null,
          marginColor: null,
          usageCount: Number.isFinite(usageCount) ? usageCount : 0,
          usageSources,
        }
      }

      const marginPct = Number.parseFloat((((charge - ourCost) / charge) * 100).toFixed(0))
      return {
        packageId,
        name: row.name ?? `Box #${packageId}`,
        dimsText,
        length,
        width,
        height,
        ourCost,
        charge,
        isCustom,
        marginPct,
        marginColor: marginPct >= 30 ? 'var(--green)' : marginPct >= 0 ? 'var(--yellow,#f59e0b)' : 'var(--red)',
        usageCount: Number.isFinite(usageCount) ? usageCount : 0,
        usageSources,
      }
    })
}

export function buildFetchRefRatesStartText(result: FetchBillingReferenceRatesResult) {
  if (!result.ok && result.message?.includes('Already running')) return 'Already running — checking status…'
  if (result.total === 0) return 'All orders already have ref rates.'
  return `Fetching rates for ${result.orders ?? 0} orders (${result.queued ?? 0} unique combos)…`
}

export function buildFetchRefRatesProgressText(status: BillingReferenceRateFetchStatusDto) {
  return `Progress: ${status.done}/${status.total}${status.errors ? ` (${status.errors} errors)` : ''}`
}

export function buildFetchRefRatesDoneText(status: BillingReferenceRateFetchStatusDto) {
  return `✓ Done — ${status.done} combos fetched${status.errors ? `, ${status.errors} errors` : ''}`
}

export function buildBackfillRefRatesToast(result: BackfillBillingReferenceRatesResult) {
  if (result.message) return result.message
  return `Backfill done — ${result.filled} orders filled, ${result.missing} missing from cache`
}

export function buildGenerateBillingStatus(
  generated: number | null | undefined,
  total: number | null | undefined
) {
  const g = Number(generated ?? 0)
  const t = Number(total ?? 0)
  return `Generated ${g} line items · $${t.toFixed(2)} total`
}

// Deprecated — use openBillingInvoice() instead. Kept as a no-op shim in
// case any v2-legacy caller still imports it.
export function getBillingInvoiceUrl(clientId: number, from: string, to: string) {
  const params = new URLSearchParams({
    clientId: String(clientId),
    from,
    to,
  })
  return `/api/billing/invoice?${params.toString()}`
}

// PS-069 — decide what the Line Items panel should render, so a Summary row that
// claims billed orders can never silently show the normal "No line items found"
// empty state. Pure + unit-tested in scripts/ps-069-billing-detail-consistency-guard.ts.
//
//   loading  → spinner
//   error    → a real /billing/details failure (must win even if Summary claims
//              orders — never hide an API error as empty)
//   rows     → details returned line rows
//   mismatch → details returned ZERO rows but Summary claims orders/totals for
//              this client/range (stale summary cache or mid-regenerate race) —
//              show a warning + an operator next step (Update Billing/Regenerate)
//   empty    → details empty AND Summary also zero — legitimate empty state
export type BillingDetailPanelState = 'loading' | 'error' | 'rows' | 'mismatch' | 'empty'

export function classifyBillingDetailPanel(input: {
  loading: boolean
  hasError: boolean
  rowCount: number
  summaryOrders: number
  summaryTotal: number
}): BillingDetailPanelState {
  if (input.loading) return 'loading'
  // An API error must surface even when Summary claims orders — the whole PS-069
  // bug is that a failed details fetch was being shown as a normal empty table.
  if (input.hasError) return 'error'
  if (input.rowCount > 0) return 'rows'
  // rowCount === 0 below: distinguish a real empty range from a stale/racey
  // Summary that still claims this client has billed orders.
  if ((input.summaryOrders ?? 0) > 0 || (input.summaryTotal ?? 0) > 0) return 'mismatch'
  return 'empty'
}
