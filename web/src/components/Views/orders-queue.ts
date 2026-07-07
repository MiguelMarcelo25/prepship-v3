interface QueueToastItem {
  sku?: string | null
  name?: string | null
  quantity?: number | null
}

interface QueueToastLine {
  label: string
  quantity: number
}

function mergeQueueToastItems(items: QueueToastItem[]): QueueToastLine[] {
  const merged = new Map<string, QueueToastLine>()

  for (const item of items) {
    const sku = item.sku?.trim() || ''
    const name = item.name?.trim() || ''
    const key = `${sku.toLowerCase()}|${name.toLowerCase()}`
    const label = sku || name || 'Item'
    const quantity = typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1
    const existing = merged.get(key)

    if (existing) {
      existing.quantity += quantity
      continue
    }

    merged.set(key, { label, quantity })
  }

  return [...merged.values()]
}

export function formatQueuedItemsSummary(items: QueueToastItem[], maxItems = 3): string {
  const mergedItems = mergeQueueToastItems(items)

  if (mergedItems.length === 0) {
    return 'Item'
  }

  const visibleItems = mergedItems.slice(0, maxItems)
  const summary = visibleItems.map((item) => `${item.label} x${item.quantity}`).join(', ')
  const overflow = mergedItems.length - visibleItems.length

  return overflow > 0 ? `${summary} +${overflow} more` : summary
}

export function formatQueuedOrderToast(
  orderNumber: string | number | null | undefined,
  items: QueueToastItem[],
): string {
  const orderLabel = orderNumber ? String(orderNumber) : 'Order'
  return `✅ ${orderLabel} sent to queue: ${formatQueuedItemsSummary(items)}`
}

interface QueuedOrdersToastIssues {
  skippedCount?: number
  failedCount?: number
  skippedReasons?: string[]
  failedReasons?: string[]
}

function normalizeQueuedOrdersToastIssues(issues: number | QueuedOrdersToastIssues): QueuedOrdersToastIssues {
  if (typeof issues === 'number') {
    return { skippedCount: Math.max(0, issues) }
  }
  return issues
}

function formatIssueDetails(label: string, reasons: string[] | undefined): string | null {
  const cleanReasons = (reasons ?? [])
    .map((reason) => reason.trim())
    .filter(Boolean)

  if (cleanReasons.length === 0) return null
  return `${label}: ${cleanReasons.join('; ')}`
}

export function formatQueuedOrdersToast(
  orderCount: number,
  items: QueueToastItem[],
  issues: number | QueuedOrdersToastIssues = 0,
): string {
  const normalizedIssues = normalizeQueuedOrdersToastIssues(issues)
  const skippedCount = Math.max(0, normalizedIssues.skippedCount ?? 0)
  const failedCount = Math.max(0, normalizedIssues.failedCount ?? 0)
  if (skippedCount > 0 || failedCount > 0) {
    const counts = [`${orderCount} queued`]
    if (skippedCount > 0) counts.push(`${skippedCount} skipped`)
    if (failedCount > 0) counts.push(`${failedCount} failed`)

    const details = [
      formatIssueDetails('Skipped', normalizedIssues.skippedReasons),
      formatIssueDetails('Failed', normalizedIssues.failedReasons),
    ].filter((detail): detail is string => Boolean(detail))

    return `${counts.join(', ')}${details.length > 0 ? ` - ${details.join(' | ')}` : ''}`
  }

  const orderLabel = `${orderCount} order${orderCount === 1 ? '' : 's'}`
  return `✅ ${orderLabel} sent to queue: ${formatQueuedItemsSummary(items)}`
}
