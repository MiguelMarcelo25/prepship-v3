// @ts-nocheck
export interface GroupedOrdersBySku<T> {
  key: string
  sku: string
  quantity: number | null
  count: number
  orders: T[]
}

export function groupOrdersBySku<T>(
  orders: T[],
  getSku: (order: T) => string | null | undefined,
  getQuantity: (order: T) => number | null | undefined,
): GroupedOrdersBySku<T>[] {
  const groups = new Map<string, GroupedOrdersBySku<T>>()

  for (const order of orders) {
    const rawSku = getSku(order)?.trim() || ''
    const rawQuantity = getQuantity(order)
    const quantity = typeof rawQuantity === 'number' && Number.isFinite(rawQuantity)
      ? rawQuantity
      : null
    const groupKey = `${rawSku.toLowerCase()}|qty:${quantity ?? 'unknown'}`
    const label = rawSku || 'Unknown SKU'
    const existing = groups.get(groupKey)

    if (existing) {
      existing.orders.push(order)
      existing.count += 1
      continue
    }

    groups.set(groupKey, {
      key: groupKey,
      sku: label,
      quantity,
      count: 1,
      orders: [order],
    })
  }

  return [...groups.values()]
}
