// @ts-nocheck
export interface GroupedOrdersBySku<T> {
  sku: string
  count: number
  orders: T[]
}

export function groupOrdersBySku<T>(
  orders: T[],
  getSku: (order: T) => string | null | undefined,
): GroupedOrdersBySku<T>[] {
  const groups = new Map<string, GroupedOrdersBySku<T>>()

  for (const order of orders) {
    const rawSku = getSku(order)?.trim() || ''
    const groupKey = rawSku.toLowerCase()
    const label = rawSku || 'Unknown SKU'
    const existing = groups.get(groupKey)

    if (existing) {
      existing.orders.push(order)
      existing.count += 1
      continue
    }

    groups.set(groupKey, {
      sku: label,
      count: 1,
      orders: [order],
    })
  }

  return [...groups.values()]
}
