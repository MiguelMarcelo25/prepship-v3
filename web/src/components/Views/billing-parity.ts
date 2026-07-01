import type { PackageDto } from '../../types/api'

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
}
export type BillingSummaryDto = BillingAnyRecord & {
  clientId: number
  clientName?: string | null
}
export type BillingDetailDto = BillingAnyRecord
export type BillingPackagePriceDto = BillingAnyRecord & {
  packageId: number
  price: number
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
  storageFeePerCuFt: number
  billingMode: string
  active: boolean
}

export type BillingPresetId = 'all' | 'this_month' | 'last_month' | 'last_30' | 'last_90'

export interface BillingDateRange {
  from: string
  to: string
}

export interface BillingConfigDraft {
  pickPackFee: string
  pickPackMaxUnits: string
  additionalUnitFee: string
  packageCostMarkup: string
  shippingMarkupPct: string
  shippingMarkupFlat: string
  storageFeePerCuFt: string
  billingMode: string
  active: boolean
}

export type BillingDetailColumnId =
  | 'actions'
  | 'orderNumber'
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
  ourCost: number | null
  charge: number
  isCustom: boolean
  marginPct: number | null
  marginColor: string | null
}

export const BILLING_DETAIL_COLUMNS: BillingDetailColumn[] = [
  { id: 'actions', label: 'Actions', align: 'center', always: true },
  { id: 'orderNumber', label: 'Order #', align: 'left', always: true },
  { id: 'shipDate', label: 'Ship Date', align: 'left', always: false },
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

// v4 (2026-05-27): defaults now expose every billing detail column plus
// row actions so operators can audit/edit a full invoice line at once.
// Bumping the storage key resets returning users to the new default
// order; if they had custom toggles, they re-pick them once.
const BILLING_DETAIL_COLS_KEY = 'billing_detail_cols_v5'

const DEFAULT_BILLING_DETAIL_COLUMN_IDS: BillingDetailColumnId[] = [
  'actions',
  'orderNumber',
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

function formatDateInput(value: Date) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addCalendarDays(value: Date, days: number) {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

function parseNumber(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function moneyNumber(value: number) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2))
}

export function calculateBillingPickPackFee(input: {
  baseFee: number
  additionalUnitFee: number
  quantity: number
  includedUnits?: number
}) {
  const includedUnits = Math.max(1, Math.floor(input.includedUnits ?? 1))
  const quantity = Math.max(0, Number(input.quantity) || 0)
  const extraUnits = Math.max(0, quantity - includedUnits)
  return moneyNumber((Number(input.baseFee) || 0) + extraUnits * (Number(input.additionalUnitFee) || 0))
}

export function calculateBillingFulfillmentFee(input: {
  shippingCharge: number
  pickPackFee: number
  boxFee: number
  storageFee: number
}) {
  return moneyNumber(
    (Number(input.shippingCharge) || 0)
      + (Number(input.pickPackFee) || 0)
      + (Number(input.boxFee) || 0)
      + (Number(input.storageFee) || 0),
  )
}

export function getBillingInitialRange(now = new Date()): BillingDateRange {
  // Default the billing summary to the last 30 days (was 90) so the
  // initial fetch matches the 'last_30' preset selected on load.
  const from = addCalendarDays(now, -29)
  return {
    from: formatDateInput(from),
    to: formatDateInput(now),
  }
}

export function getBillingPresetRange(preset: BillingPresetId, now = new Date()): BillingDateRange {
  let from: Date
  let to: Date

  if (preset === 'all') {
    from = new Date(2020, 0, 1)
    to = new Date(now)
  } else if (preset === 'this_month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1)
    to = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  } else if (preset === 'last_month') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    to = new Date(now.getFullYear(), now.getMonth(), 0)
  } else if (preset === 'last_30') {
    to = new Date(now)
    from = addCalendarDays(now, -29)
  } else {
    to = new Date(now)
    from = addCalendarDays(now, -89)
  }

  return {
    from: formatDateInput(from),
    to: formatDateInput(to),
  }
}

export function createBillingConfigDraft(config: BillingConfigDto): BillingConfigDraft {
  // Accept either the v4 camelCase (`billingMode`, `pickPackMaxUnits`) or
  // legacy snake_case (`billing_mode`) shapes on the incoming DTO.
  const c = config as any
  return {
    pickPackFee: Number(c.pickPackFee ?? 0).toFixed(2),
    pickPackMaxUnits: String(c.pickPackMaxUnits ?? 1),
    additionalUnitFee: Number(c.additionalUnitFee ?? 0).toFixed(2),
    packageCostMarkup: Number(c.packageCostMarkup ?? 0).toFixed(1),
    shippingMarkupPct: Number(c.shippingMarkupPct ?? 0).toFixed(1),
    shippingMarkupFlat: Number(c.shippingMarkupFlat ?? 0).toFixed(2),
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
    storageFeePerCuFt: parseNumber(draft.storageFeePerCuFt),
    billingMode: draft.billingMode || 'per_shipment',
    active: draft.active !== false,
  } as UpdateBillingConfigInput
}

export function buildBillingSummaryTotals(rows: BillingSummaryDto[]): BillingSummaryTotals {
  return rows.reduce<BillingSummaryTotals>((totals, row) => {
    const pickPack = Number(row.pickPackTotal || 0)
    const additional = Number(row.additionalTotal || 0)
    const pickPackFee = Number(row.pickPackFeeTotal ?? row.pick_pack_fee_total ?? pickPack + additional)
    const shipping = Number(row.shippingTotal || 0)
    const boxFee = Number(row.packageTotal || 0)
    const storage = Number(row.storageTotal || 0)
    const fulfillmentFee = Number(
      row.fulfillmentFeeTotal
        ?? row.fulfillment_fee_total
        ?? calculateBillingFulfillmentFee({
          shippingCharge: shipping,
          pickPackFee,
          boxFee,
          storageFee: storage,
        }),
    )
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
// Display and sort by the leading YYYY-MM-DD components only, with no timezone
// conversion. Otherwise 2026-06-30T00:00Z renders as 06/29/26 5:00 PM in CA.
export function formatBillingShipDate(value: string | null | undefined) {
  const parts = billingDayParts(value)
  if (!parts) return value ? String(value) : '—'
  return `${parts.month}/${parts.day}/${parts.year.slice(2)}`
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

function billingBadgeList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const badges: string[] = []
  for (const badge of value) {
    if (typeof badge !== 'string') continue
    const trimmed = badge.trim()
    if (trimmed && !badges.includes(trimmed)) badges.push(trimmed)
  }
  return badges
}

function mergeBillingBadges(...values: unknown[]): string[] {
  const merged: string[] = []
  for (const value of values) {
    for (const badge of billingBadgeList(value)) {
      if (!merged.includes(badge)) merged.push(badge)
    }
  }
  return merged
}

function hasNoBoxCostBadge(row: Record<string, unknown>, badges = mergeBillingBadges(row.billingBadges, row.billing_badges)): boolean {
  return row.boxCostAlert === true || row.box_cost_alert === true || badges.includes('NO_BOX_COST')
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

// Collapse per-lineType rows into one row per order. The generator
// emits a separate BillingDetailDto for each fee type (pick_pack,
// additional_unit, package_cost, shipping, storage) which would
// otherwise show as multiple rows for the same order in the UI. After
// this pass each merged row carries explicit *Total fields, which
// `computeBillingDetailMetrics` prefers over the lineType fallback —
// so the downstream rendering and sorting code needs no changes.
//
// Aggregation key is `orderId`. Storage rows (no orderId) fall back
// to their description so each storage line stays distinct.
export function aggregateBillingDetailRowsByOrder(rows: BillingDetailDto[]): BillingDetailDto[] {
  const byKey = new Map<string, BillingDetailDto & Record<string, unknown>>()
  const order: string[] = []

  const num = (value: unknown) => {
    if (value == null) return 0
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  for (const row of rows) {
    const orderId = (row as { orderId?: unknown }).orderId
    const description = (row as { description?: unknown }).description
    const lineType = (row as { lineType?: unknown }).lineType
    const key =
      orderId != null && orderId !== ''
        ? `order:${orderId}`
        : `storage:${String(description ?? '')}:${String(lineType ?? '')}`

    const metrics = computeBillingDetailMetrics(row)
    const rowBadges = mergeBillingBadges(
      (row as { billingBadges?: unknown }).billingBadges,
      (row as { billing_badges?: unknown }).billing_badges,
    )
    const rowBoxCostAlert = hasNoBoxCostBadge(row as Record<string, unknown>, rowBadges)

    if (!byKey.has(key)) {
      // Seed merged row with this lineType's contribution. Reset
      // totalCost so the *Total fallback never re-applies the same
      // dollars (lineType becomes 'merged' as a tripwire).
      byKey.set(key, {
        ...(row as Record<string, unknown>),
        lineType: 'merged',
        line_type: 'merged',
        pickpackTotal: metrics.pickPack,
        pick_pack_total: metrics.pickPack,
        additionalTotal: metrics.additional,
        additional_total: metrics.additional,
        packageTotal: metrics.packageCost,
        package_total: metrics.packageCost,
        shippingTotal: metrics.shipping,
        shipping_total: metrics.shipping,
        storageTotal: num((row as { storageTotal?: unknown; storage_total?: unknown }).storageTotal
          ?? (row as { storage_total?: unknown }).storage_total
          ?? (lineType === 'storage' ? metrics.total : 0)),
        storage_total: num((row as { storageTotal?: unknown; storage_total?: unknown }).storageTotal
          ?? (row as { storage_total?: unknown }).storage_total
          ?? (lineType === 'storage' ? metrics.total : 0)),
        grandTotal: metrics.total,
        grand_total: metrics.total,
        totalCost: 0,
        total_cost: 0,
        // PS-068: carry the box-line stale-price flag up to the order row so
        // the Box Cost cell can badge "stale — regenerate". Only package_cost
        // lines set this, so OR-ing across the order's lines is correct.
        stalePackagePrice: (row as { stalePackagePrice?: unknown }).stalePackagePrice === true,
        // PS-207: carry the box-review flag + backend reason up to the order
        // row (only package_cost_missing lines set them). The FE renders the
        // chip from these — it does NO box policy math of its own.
        packageCostNeedsReview: (row as { packageCostNeedsReview?: unknown }).packageCostNeedsReview === true,
        packageCostReviewReason: (row as { packageCostReviewReason?: unknown }).packageCostReviewReason ?? null,
        boxCostAlert: rowBoxCostAlert,
        box_cost_alert: rowBoxCostAlert,
        billingBadges: rowBadges,
        billing_badges: rowBadges,
      } as BillingDetailDto & Record<string, unknown>)
      order.push(key)
      continue
    }

    const existing = byKey.get(key)!
    existing.pickpackTotal = num(existing.pickpackTotal) + metrics.pickPack
    existing.pick_pack_total = existing.pickpackTotal
    existing.additionalTotal = num(existing.additionalTotal) + metrics.additional
    existing.additional_total = existing.additionalTotal
    existing.packageTotal = num(existing.packageTotal) + metrics.packageCost
    existing.package_total = existing.packageTotal
    existing.shippingTotal = num(existing.shippingTotal) + metrics.shipping
    existing.shipping_total = existing.shippingTotal
    existing.grandTotal = num(existing.grandTotal) + metrics.total
    existing.grand_total = existing.grandTotal
    existing.stalePackagePrice =
      (existing as { stalePackagePrice?: unknown }).stalePackagePrice === true ||
      (row as { stalePackagePrice?: unknown }).stalePackagePrice === true
    existing.packageCostNeedsReview =
      (existing as { packageCostNeedsReview?: unknown }).packageCostNeedsReview === true ||
      (row as { packageCostNeedsReview?: unknown }).packageCostNeedsReview === true
    existing.packageCostReviewReason =
      (existing as { packageCostReviewReason?: unknown }).packageCostReviewReason ??
      (row as { packageCostReviewReason?: unknown }).packageCostReviewReason ??
      null
    const mergedBadges = mergeBillingBadges(existing.billingBadges, existing.billing_badges, rowBadges)
    existing.billingBadges = mergedBadges
    existing.billing_badges = mergedBadges
    existing.boxCostAlert =
      (existing as { boxCostAlert?: unknown }).boxCostAlert === true ||
      (existing as { box_cost_alert?: unknown }).box_cost_alert === true ||
      rowBoxCostAlert ||
      mergedBadges.includes('NO_BOX_COST')
    existing.box_cost_alert = existing.boxCostAlert

    // First-wins for the non-monetary fields. The shipping row is
    // usually richer (carrier, ref rates, ship date, actual label
    // cost) than the pick_pack row, so we backfill from later rows
    // any time the seed row had a null.
    const carryString = (
      ours: string | null | undefined,
      theirs: string | null | undefined,
    ) => (ours && String(ours).trim() ? ours : theirs)
    const carryNullable = (ours: unknown, theirs: unknown) => (ours != null && ours !== '' ? ours : theirs)

    existing.shipDate = carryString(
      existing.shipDate as string | null | undefined,
      (row as { shipDate?: string | null }).shipDate,
    )
    existing.carrierCode = carryString(
      existing.carrierCode as string | null | undefined,
      (row as { carrierCode?: string | null }).carrierCode,
    )
    existing.carrierNickname = carryString(
      existing.carrierNickname as string | null | undefined,
      (row as { carrierNickname?: string | null }).carrierNickname,
    )
    existing.providerAccountNickname = carryString(
      existing.providerAccountNickname as string | null | undefined,
      (row as { providerAccountNickname?: string | null }).providerAccountNickname,
    )
    existing.itemNames = carryString(
      existing.itemNames as string | null | undefined,
      (row as { itemNames?: string | null }).itemNames,
    )
    existing.itemSkus = carryString(
      existing.itemSkus as string | null | undefined,
      (row as { itemSkus?: string | null }).itemSkus,
    )
    existing.packageName = carryString(
      existing.packageName as string | null | undefined,
      (row as { packageName?: string | null }).packageName,
    )

    existing.totalQty = carryNullable(existing.totalQty, (row as { totalQty?: unknown }).totalQty)
    existing.selectedRateCost = carryNullable(
      existing.selectedRateCost,
      (row as { selectedRateCost?: unknown }).selectedRateCost,
    )
    existing.selected_rate_cost = carryNullable(
      existing.selected_rate_cost,
      (row as { selected_rate_cost?: unknown }).selected_rate_cost,
    )
    existing.actualLabelCost = carryNullable(
      existing.actualLabelCost,
      (row as { actualLabelCost?: unknown }).actualLabelCost,
    )
    existing.ref_ups_rate = carryNullable(
      existing.ref_ups_rate,
      (row as { ref_ups_rate?: unknown }).ref_ups_rate,
    )
    existing.ref_usps_rate = carryNullable(
      existing.ref_usps_rate,
      (row as { ref_usps_rate?: unknown }).ref_usps_rate,
    )
  }

  return order.map((key) => byKey.get(key) as BillingDetailDto)
}

export function computeBillingDetailMetrics(detail: BillingDetailDto): BillingDetailMetrics {
  const lineType = detail.lineType ?? detail.line_type
  const lineTotal = Number(detail.totalCost ?? detail.total_cost ?? 0) || 0
  const pickPack = Number(detail.pickpackTotal ?? detail.pick_pack_total ?? (lineType === 'pick_pack' ? lineTotal : 0)) || 0
  const additional = Number(detail.additionalTotal ?? detail.additional_total ?? (lineType === 'additional_unit' ? lineTotal : 0)) || 0
  const packageCost = Number(detail.packageTotal ?? detail.package_total ?? (lineType === 'package_cost' ? lineTotal : 0)) || 0
  const shipping = Number(detail.shippingTotal ?? detail.shipping_total ?? (lineType === 'shipping' ? lineTotal : 0)) || 0
  const storage = Number(detail.storageTotal ?? detail.storage_total ?? (lineType === 'storage' ? lineTotal : 0)) || 0
  const pickPackFee = Number(detail.pickPackFeeTotal ?? detail.pick_pack_fee_total ?? pickPack + additional) || 0
  const fulfillmentFee = Number(
    detail.fulfillmentFeeTotal
      ?? detail.fulfillment_fee_total
      ?? calculateBillingFulfillmentFee({
        shippingCharge: shipping,
        pickPackFee,
        boxFee: packageCost,
        storageFee: storage,
      }),
  ) || 0
  const total = Number(detail.grandTotal ?? detail.grand_total ?? detail.total ?? 0) || fulfillmentFee
  const selectedRateCost = detail.selectedRateCost ?? detail.selected_rate_cost ?? detail.actualLabelCost ?? detail.actual_label_cost
  const ourCost = Number(selectedRateCost ?? 0) || 0
  const margin = shipping - ourCost
  const refUpsRate = detail.ref_ups_rate ?? detail.refUpsRate
  const refUspsRate = detail.ref_usps_rate ?? detail.refUspsRate
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
  packages: PackageDto[],
  savedRows: BillingPackagePriceDto[],
  draftPrices?: Record<number, string | number>,
) {
  const savedByPackageId = new Map(savedRows.map((row) => [row.packageId, row]))

  return packages
    .filter((pkg) => pkg.source === 'custom')
    .map<BillingPackagePriceRow>((pkg) => {
      const saved = savedByPackageId.get(pkg.packageId)
      const draft = draftPrices?.[pkg.packageId]
      const charge = draft != null ? parseNumber(String(draft)) : saved ? saved.price : 0
      const ourCost = pkg.unitCost != null ? Number(pkg.unitCost) : null
      const dimsText = pkg.length && pkg.width && pkg.height ? `${pkg.length}×${pkg.width}×${pkg.height}"` : '—'

      if (ourCost == null || charge <= 0) {
        return {
          packageId: pkg.packageId,
          name: pkg.name,
          dimsText,
          ourCost,
          charge,
          isCustom: Boolean(saved?.is_custom),
          marginPct: null,
          marginColor: null,
        }
      }

      const marginPct = Number.parseFloat((((charge - ourCost) / charge) * 100).toFixed(0))
      return {
        packageId: pkg.packageId,
        name: pkg.name,
        dimsText,
        ourCost,
        charge,
        isCustom: Boolean(saved?.is_custom),
        marginPct,
        marginColor: marginPct >= 30 ? 'var(--green)' : marginPct >= 0 ? 'var(--yellow,#f59e0b)' : 'var(--red)',
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
