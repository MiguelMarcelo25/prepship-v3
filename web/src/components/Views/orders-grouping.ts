// @ts-nocheck
export interface SkuCompositionInput {
  sku?: string | null
  quantity?: number | null
}

export interface SkuCompositionPart {
  key: string
  sku: string
  quantity: number
  missingSku: boolean
}

export interface GroupedOrdersBySku<T> {
  key: string
  sku: string
  label: string
  quantity: number | null
  composition: SkuCompositionPart[]
  count: number
  orders: T[]
}

function normalizeSkuForKey(sku: string | null | undefined) {
  return (sku ?? '').trim().toLowerCase()
}

function normalizeSkuForDisplay(sku: string | null | undefined) {
  return (sku ?? '').trim()
}

function normalizeQuantity(quantity: number | null | undefined) {
  return typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0
    ? quantity
    : 1
}

export function buildSkuCompositionKey(items: SkuCompositionInput[] | null | undefined) {
  const grouped = new Map<string, SkuCompositionPart>()

  for (const item of items ?? []) {
    const displaySku = normalizeSkuForDisplay(item?.sku)
    const normalizedSku = normalizeSkuForKey(item?.sku)
    const missingSku = normalizedSku === ''
    const key = missingSku ? '__missing_sku__' : normalizedSku
    const quantity = normalizeQuantity(item?.quantity)
    const existing = grouped.get(key)

    if (existing) {
      existing.quantity += quantity
      continue
    }

    grouped.set(key, {
      key,
      sku: missingSku ? 'Missing SKU' : displaySku,
      quantity,
      missingSku,
    })
  }

  if (grouped.size === 0) {
    grouped.set('__missing_sku__', {
      key: '__missing_sku__',
      sku: 'Missing SKU',
      quantity: 1,
      missingSku: true,
    })
  }

  const composition = [...grouped.values()].sort((left, right) => {
    if (left.missingSku !== right.missingSku) return left.missingSku ? 1 : -1
    return left.key.localeCompare(right.key)
  })
  const key = composition
    .map((part) => `${part.key}:${Number.isInteger(part.quantity) ? part.quantity : part.quantity.toFixed(3)}`)
    .join('|')
  const label = composition.map((part) => `${part.sku} x${part.quantity}`).join(' + ')
  const primary = composition[0] ?? null

  return {
    key,
    label,
    sku: primary?.sku ?? 'Missing SKU',
    quantity: composition.length === 1 ? primary?.quantity ?? null : null,
    composition,
  }
}

export function groupOrdersBySku<T>(
  orders: T[],
  getSku: (order: T) => string | null | undefined,
  getQuantity: (order: T) => number | null | undefined,
  getItems?: (order: T) => SkuCompositionInput[] | null | undefined,
): GroupedOrdersBySku<T>[] {
  const groups = new Map<string, GroupedOrdersBySku<T>>()

  for (const order of orders) {
    const composition = getItems
      ? buildSkuCompositionKey(getItems(order))
      : buildSkuCompositionKey([{ sku: getSku(order), quantity: getQuantity(order) }])
    const groupKey = composition.key
    const existing = groups.get(groupKey)

    if (existing) {
      existing.orders.push(order)
      existing.count += 1
      continue
    }

    groups.set(groupKey, {
      key: groupKey,
      sku: composition.sku,
      label: composition.label,
      quantity: composition.quantity,
      composition: composition.composition,
      count: 1,
      orders: [order],
    })
  }

  return [...groups.values()]
}
