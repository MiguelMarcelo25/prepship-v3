import { computeBillingDetailMetrics, type BillingDetailDto } from './billing-parity'

export type BillingEditDraft = {
  pickPack: string
  additional: string
  packageCost: string
  shipping: string
  packageId: string
}

export type BillingEditDraftCache = Record<string, BillingEditDraft>

export function createBillingEditDraft(row: BillingDetailDto): BillingEditDraft {
  const metrics = computeBillingDetailMetrics(row)
  const rawPackageId =
    (row as Record<string, unknown>).packageId ??
    (row as Record<string, unknown>).package_id ??
    (row as Record<string, unknown>).selectedPackageId ??
    (row as Record<string, unknown>).selected_package_id
  return {
    pickPack: metrics.pickPack.toFixed(2),
    additional: metrics.additional.toFixed(2),
    packageCost: metrics.packageCost.toFixed(2),
    shipping: metrics.shipping.toFixed(2),
    packageId: rawPackageId != null ? String(rawPackageId) : '',
  }
}

export function billingEditDraftKey(row: BillingDetailDto | null | undefined): string | null {
  if (!row) return null
  const orderId = row.orderId ?? row.order_id ?? row.id
  if (orderId != null && String(orderId).trim() !== '') return `order:${String(orderId)}`
  const orderNumber = row.orderNumber ?? row.order_number
  if (orderNumber != null && String(orderNumber).trim() !== '') return `order-number:${String(orderNumber)}`
  return null
}

export function rememberBillingEditDraft(
  cache: BillingEditDraftCache,
  row: BillingDetailDto | null | undefined,
  draft: BillingEditDraft,
): BillingEditDraftCache {
  const key = billingEditDraftKey(row)
  if (!key) return cache
  return { ...cache, [key]: { ...draft } }
}

export function clearBillingEditDraft(
  cache: BillingEditDraftCache,
  row: BillingDetailDto | null | undefined,
): BillingEditDraftCache {
  const key = billingEditDraftKey(row)
  if (!key || !(key in cache)) return cache
  const next = { ...cache }
  delete next[key]
  return next
}

function positiveMoneyDraft(value: string) {
  const amount = Number.parseFloat(value)
  return Number.isFinite(amount) && amount > 0
}

function zeroMoneyDraft(value: string) {
  const amount = Number.parseFloat(value)
  return Number.isFinite(amount) && amount === 0
}

function boxId(row: BillingDetailDto | null | undefined): string | null {
  const id = row?.packageId ?? row?.package_id ?? row?.selectedPackageId ?? row?.selected_package_id
  return id == null || String(id).trim() === '' ? null : String(id).trim()
}

function boxLabel(row: BillingDetailDto | null | undefined): string | null {
  const label = row?.packageName ?? row?.package_name ?? row?.boxSize ?? row?.box_size
  return label == null || String(label).trim() === '' ? null : String(label).trim().toLowerCase()
}

function sameBillingBox(a: BillingDetailDto | null | undefined, b: BillingDetailDto | null | undefined) {
  const aId = boxId(a)
  const bId = boxId(b)
  if (aId && bId) return aId === bId
  const aLabel = boxLabel(a)
  const bLabel = boxLabel(b)
  return Boolean(aLabel && bLabel && aLabel === bLabel)
}

export function billingEditDraftForRow(
  cache: BillingEditDraftCache,
  row: BillingDetailDto,
  fallback: BillingEditDraft,
  carryFrom: { row: BillingDetailDto; draft: BillingEditDraft } | null,
): BillingEditDraft {
  const key = billingEditDraftKey(row)
  const cached = key ? cache[key] : null
  if (cached) return { ...cached }

  if (
    carryFrom &&
    sameBillingBox(carryFrom.row, row) &&
    zeroMoneyDraft(fallback.packageCost) &&
    positiveMoneyDraft(carryFrom.draft.packageCost)
  ) {
    return { ...fallback, packageCost: carryFrom.draft.packageCost }
  }

  return fallback
}
