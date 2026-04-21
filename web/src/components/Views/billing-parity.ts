// @ts-nocheck
import type {
  BackfillBillingReferenceRatesResult,
  BillingConfigDto,
  BillingDetailDto,
  BillingPackagePriceDto,
  BillingReferenceRateFetchStatusDto,
  BillingSummaryDto,
  FetchBillingReferenceRatesResult,
  PackageDto,
  UpdateBillingConfigInput,
} from '../../types/api'

export type BillingPresetId = 'this_month' | 'last_month' | 'last_30' | 'last_90'

export interface BillingDateRange {
  from: string
  to: string
}

export interface BillingConfigDraft {
  pickPackFee: string
  additionalUnitFee: string
  shippingMarkupPct: string
  shippingMarkupFlat: string
  storageFeePerCuFt: string
  billing_mode: string
}

export type BillingDetailColumnId =
  | 'orderNumber'
  | 'shipDate'
  | 'itemNames'
  | 'itemSkus'
  | 'totalQty'
  | 'pickpack'
  | 'additional'
  | 'packageCost'
  | 'packageName'
  | 'bestRate'
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
  package: number
  storage: number
  shipping: number
  grand: number
}

export interface BillingDetailMetrics {
  pickPack: number
  additional: number
  packageCost: number
  shipping: number
  total: number
  ourCost: number
  margin: number
  ssCharged: boolean
  chargedRate: 'bestRate' | 'upsss' | 'uspsss' | null
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
  { id: 'orderNumber', label: 'Order #', align: 'left', always: true },
  { id: 'shipDate', label: 'Ship Date', align: 'left', always: false },
  { id: 'itemNames', label: 'Item Name', align: 'left', always: false },
  { id: 'itemSkus', label: 'SKU', align: 'left', always: false },
  { id: 'totalQty', label: 'Qty', align: 'right', always: false },
  { id: 'pickpack', label: 'Pick & Pack', align: 'right', always: false },
  { id: 'additional', label: 'Addl Units', align: 'right', always: false },
  { id: 'packageCost', label: 'Box Cost', align: 'right', always: false },
  { id: 'packageName', label: 'Box Size', align: 'center', always: false },
  { id: 'bestRate', label: 'Best Rate', align: 'right', always: false },
  { id: 'upsss', label: 'UPS SS', align: 'right', always: false },
  { id: 'uspsss', label: 'USPS SS', align: 'right', always: false },
  { id: 'shipping', label: 'Shipping', align: 'right', always: false },
  { id: 'total', label: 'Total', align: 'right', always: true },
  { id: 'margin', label: 'Shipping Margin', align: 'right', always: false },
]

const BILLING_DETAIL_COLS_KEY = 'billing_detail_cols_v1'

const DEFAULT_BILLING_DETAIL_COLUMN_IDS: BillingDetailColumnId[] = [
  'orderNumber',
  'shipDate',
  'itemNames',
  'itemSkus',
  'totalQty',
  'pickpack',
  'additional',
  'shipping',
  'total',
]

function formatDateInput(value: Date) {
  return value.toISOString().slice(0, 10)
}

function parseNumber(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function getBillingInitialRange(now = new Date()): BillingDateRange {
  const from = new Date(now)
  from.setDate(from.getDate() - 90)
  return {
    from: formatDateInput(from),
    to: formatDateInput(now),
  }
}

export function getBillingPresetRange(preset: BillingPresetId, now = new Date()): BillingDateRange {
  let from: Date
  let to: Date

  if (preset === 'this_month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1)
    to = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  } else if (preset === 'last_month') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    to = new Date(now.getFullYear(), now.getMonth(), 0)
  } else if (preset === 'last_30') {
    to = new Date(now)
    from = new Date(now)
    from.setDate(from.getDate() - 30)
  } else {
    to = new Date(now)
    from = new Date(now)
    from.setDate(from.getDate() - 90)
  }

  return {
    from: formatDateInput(from),
    to: formatDateInput(to),
  }
}

export function createBillingConfigDraft(config: BillingConfigDto): BillingConfigDraft {
  return {
    pickPackFee: config.pickPackFee.toFixed(2),
    additionalUnitFee: config.additionalUnitFee.toFixed(2),
    shippingMarkupPct: config.shippingMarkupPct.toFixed(1),
    shippingMarkupFlat: config.shippingMarkupFlat.toFixed(2),
    storageFeePerCuFt: (config.storageFeePerCuFt || 0).toFixed(3),
    billing_mode: config.billing_mode || 'label_cost',
  }
}

export function createBillingConfigDraftMap(configs: BillingConfigDto[]) {
  return Object.fromEntries(configs.map((config) => [config.clientId, createBillingConfigDraft(config)]))
}

export function buildBillingConfigInput(draft: BillingConfigDraft): UpdateBillingConfigInput {
  return {
    pickPackFee: parseNumber(draft.pickPackFee),
    additionalUnitFee: parseNumber(draft.additionalUnitFee),
    shippingMarkupPct: parseNumber(draft.shippingMarkupPct),
    shippingMarkupFlat: parseNumber(draft.shippingMarkupFlat),
    billing_mode: draft.billing_mode || 'label_cost',
    storageFeePerCuFt: parseNumber(draft.storageFeePerCuFt),
  }
}

export function buildBillingSummaryTotals(rows: BillingSummaryDto[]): BillingSummaryTotals {
  return rows.reduce<BillingSummaryTotals>((totals, row) => ({
    orders: totals.orders + (row.orderCount || 0),
    pickPack: totals.pickPack + (row.pickPackTotal || 0),
    additional: totals.additional + (row.additionalTotal || 0),
    package: totals.package + (row.packageTotal || 0),
    storage: totals.storage + (row.storageTotal || 0),
    shipping: totals.shipping + (row.shippingTotal || 0),
    grand: totals.grand + (row.grandTotal || 0),
  }), {
    orders: 0,
    pickPack: 0,
    additional: 0,
    package: 0,
    storage: 0,
    shipping: 0,
    grand: 0,
  })
}

export function formatBillingMoney(value: number | null | undefined, options: { dashIfZero?: boolean } = {}) {
  if (value == null || Number.isNaN(value)) return '—'
  if (options.dashIfZero && value <= 0) return '—'
  return `$${value.toFixed(2)}`
}

export function formatBillingDateTime(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const day = date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' })
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return `${day} ${time}`
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

export function getVisibleBillingDetailColumns(columnIds: BillingDetailColumnId[]) {
  const visible = new Set(columnIds)
  return BILLING_DETAIL_COLUMNS.filter((column) => column.always || visible.has(column.id))
}

export function computeBillingDetailMetrics(detail: BillingDetailDto): BillingDetailMetrics {
  const pickPack = detail.pickpackTotal || 0
  const additional = detail.additionalTotal || 0
  const packageCost = detail.packageTotal || 0
  const shipping = detail.shippingTotal || 0
  const total = pickPack + additional + packageCost + shipping
  const ourCost = detail.actualLabelCost || 0
  const margin = shipping - ourCost
  const ssCharged = shipping > 0 && detail.actualLabelCost != null && shipping > detail.actualLabelCost + 0.01

  let chargedRate: BillingDetailMetrics['chargedRate'] = null
  if (shipping > 0) {
    const tol = 0.01
    if (detail.actualLabelCost != null && Math.abs(shipping - detail.actualLabelCost) <= tol) chargedRate = 'bestRate'
    else if (detail.ref_ups_rate != null && Math.abs(shipping - detail.ref_ups_rate) <= tol) chargedRate = 'upsss'
    else if (detail.ref_usps_rate != null && Math.abs(shipping - detail.ref_usps_rate) <= tol) chargedRate = 'uspsss'
  }

  return {
    pickPack,
    additional,
    packageCost,
    shipping,
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

export function buildGenerateBillingStatus(generated: number, total: number) {
  return `Generated ${generated} line items · $${total.toFixed(2)} total`
}

export function getBillingInvoiceUrl(clientId: number, from: string, to: string) {
  const params = new URLSearchParams({
    clientId: String(clientId),
    from,
    to,
  })
  return `/api/billing/invoice?${params.toString()}`
}
