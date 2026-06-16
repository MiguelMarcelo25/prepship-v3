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

export function formatQueuedOrdersToast(
  orderCount: number,
  items: QueueToastItem[],
  skippedCount = 0,
): string {
  const orderLabel = `${orderCount} order${orderCount === 1 ? '' : 's'}`
  const skippedLabel = skippedCount > 0 ? ` (${skippedCount} skipped)` : ''
  return `✅ ${orderLabel} sent to queue: ${formatQueuedItemsSummary(items)}${skippedLabel}`
}
