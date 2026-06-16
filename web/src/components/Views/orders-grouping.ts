export interface SkuCompositionInput {
  sku?: string | null
  quantity?: number | null
  // Item title (eBay listings expose this as `name`/`title`). Used as the
  // identity + display fallback for no-SKU lines when titleFallback is enabled.
  title?: string | null
  name?: string | null
}

export interface SkuCompositionOptions {
  // When true, no-SKU lines that carry a title are identified and labeled by
  // that title (so distinct titles form distinct groups) instead of collapsing
  // into a single "Missing SKU" group. Enabled per-order for eBay only.
  titleFallback?: boolean
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

export function buildSkuCompositionKey(
  items: SkuCompositionInput[] | null | undefined,
  options?: SkuCompositionOptions,
) {
  const titleFallback = options?.titleFallback === true
  const grouped = new Map<string, SkuCompositionPart>()

  for (const item of items ?? []) {
    const displaySku = normalizeSkuForDisplay(item?.sku)
    const normalizedSku = normalizeSkuForKey(item?.sku)
    const hasSku = normalizedSku !== ''
    const displayTitle = normalizeSkuForDisplay(item?.title ?? item?.name)
    const normalizedTitle = normalizeSkuForKey(item?.title ?? item?.name)

    // SKU wins. For no-SKU lines, eBay (titleFallback) lines are identified and
    // labeled by their title — distinct titles → distinct groups, so the group
    // header shows the product name instead of "Missing SKU". Non-eBay no-SKU
    // lines keep the "Missing SKU" data-quality flag.
    let key: string
    let sku: string
    let missingSku: boolean
    if (hasSku) {
      key = normalizedSku
      sku = displaySku
      missingSku = false
    } else if (titleFallback && normalizedTitle !== '') {
      key = `title:${normalizedTitle}`
      sku = displayTitle
      missingSku = false
    } else {
      key = '__missing_sku__'
      sku = 'Missing SKU'
      missingSku = true
    }

    const quantity = normalizeQuantity(item?.quantity)
    const existing = grouped.get(key)

    if (existing) {
      existing.quantity += quantity
      continue
    }

    grouped.set(key, {
      key,
      sku,
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
  getTitleFallback?: (order: T) => boolean,
): GroupedOrdersBySku<T>[] {
  const groups = new Map<string, GroupedOrdersBySku<T>>()

  for (const order of orders) {
    const titleFallback = getTitleFallback?.(order) ?? false
    const composition = getItems
      ? buildSkuCompositionKey(getItems(order), { titleFallback })
      : buildSkuCompositionKey([{ sku: getSku(order), quantity: getQuantity(order) }], { titleFallback })
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
