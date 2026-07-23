import { computeBillingDetailMetrics, type BillingDetailDto } from './billing-parity'

export type BillingEditDraft = {
  pickPack: string
  additional: string
  packageCost: string
  shipping: string
  packageId: string
  reason: string
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
    reason: '',
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

export function billingEditDraftForRow(
  cache: BillingEditDraftCache,
  row: BillingDetailDto,
  fallback: BillingEditDraft,
): BillingEditDraft {
  const key = billingEditDraftKey(row)
  const cached = key ? cache[key] : null
  if (cached) return { ...cached }
  return fallback
}
