// PS-154: pure stock-math helpers extracted VERBATIM from InventoryView.tsx
// so the effective-stock / display-status / stock-tooltip / sort-value
// computations live in one shared, side-effect-free module instead of
// inline in the view. No state, no handlers, no money mutation — these
// are read-only functions over an InventoryItemDto row. InventoryView
// imports them; behavior is identical to the previous inline definitions.
type InventoryItemDto = any // TODO PS-257: restore real type
// getInventoryCuFt already lives in the parity module (imported from the
// same source the view uses) so the 'cuFt' sort branch stays canonical.
import { getInventoryCuFt } from './inventory-parity'

export type InventorySortDirection = 'asc' | 'desc'
export type InventorySortKey =
  | 'sku'
  | 'name'
  | 'store'
  | 'weight'
  | 'length'
  | 'width'
  | 'height'
  | 'dims'
  | 'cuFt'
  | 'package'
  | 'stock'
  | 'sold30'
  | 'unitsPerPack'
  | 'totalUnits'
  | 'min'
  | 'status'

export interface InventorySortState {
  key: InventorySortKey
  direction: InventorySortDirection
}

export const inventorySortCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export const inventoryStatusRank: Record<string, number> = {
  out: 0,
  low: 1,
  ok: 2,
}

export function toSortNumber(value: unknown) {
  const nextValue = Number(value)
  return Number.isFinite(nextValue) ? nextValue : 0
}

export function getInventoryDisplayStock(row: InventoryItemDto) {
  const effectiveStock = Number(row.effectiveStock)
  return Number.isFinite(effectiveStock) ? effectiveStock : toSortNumber(row.currentStock)
}

export function getInventoryDisplayStatus(row: InventoryItemDto): 'ok' | 'low' | 'out' {
  const stock = getInventoryDisplayStock(row)
  if (stock <= 0) return 'out'
  if (stock <= toSortNumber(row.minStock)) return 'low'
  return 'ok'
}

export function getInventoryStockTooltip(row: InventoryItemDto) {
  const displayStock = getInventoryDisplayStock(row)
  const cachedStock = Number((row as any).cachedStockQty)
  const auditStock = Number.isFinite(cachedStock) ? cachedStock : row.currentStock
  const tooltipParts = [
    `Received: ${row.totalReceived ?? 0}`,
    `Sold shipped all-time: ${row.totalSoldAllTime ?? 0}`,
    `Effective stock: ${displayStock}`,
  ]
  if (typeof row.effectiveStock === 'number' && row.effectiveStock !== auditStock) {
    tooltipParts.push(`Cached stockQty: ${auditStock}`)
  }
  return tooltipParts.join('\n')
}

export function getInventoryPackageSortLabel(row: InventoryItemDto) {
  if (row.packageName) return row.packageName
  if (row.packageLength > 0 || row.packageWidth > 0 || row.packageHeight > 0) {
    return `${row.packageLength}x${row.packageWidth}x${row.packageHeight}`
  }
  return ''
}

export function getInventorySortValue(row: InventoryItemDto, key: InventorySortKey) {
  switch (key) {
    case 'sku':
      return row.sku || ''
    case 'name':
      return row.name || ''
    case 'store':
      return row.clientName || ''
    case 'weight':
      return toSortNumber(row.weightOz)
    case 'length':
      return toSortNumber(row.productLength || row.packageLength)
    case 'width':
      return toSortNumber(row.productWidth || row.packageWidth)
    case 'height':
      return toSortNumber(row.productHeight || row.packageHeight)
    case 'dims':
      return toSortNumber(row.packageLength) * toSortNumber(row.packageWidth) * toSortNumber(row.packageHeight)
    case 'cuFt':
      return getInventoryCuFt(row)
    case 'package':
      return getInventoryPackageSortLabel(row)
    case 'stock':
      // Sort by the displayed value (effective stock) so the
      // operator's "sort by stock" matches what they see.
      return getInventoryDisplayStock(row)
    case 'sold30':
      return toSortNumber(row.soldLast30Days)
    case 'unitsPerPack':
      return toSortNumber(row.units_per_pack)
    case 'totalUnits':
      return getInventoryDisplayStock(row) * Math.max(1, toSortNumber(row.units_per_pack))
    case 'min':
      return toSortNumber(row.minStock)
    case 'status':
      return inventoryStatusRank[getInventoryDisplayStatus(row)] ?? 99
    default:
      return ''
  }
}

export function compareInventoryRows(left: InventoryItemDto, right: InventoryItemDto, sort: InventorySortState) {
  const leftValue = getInventorySortValue(left, sort.key)
  const rightValue = getInventorySortValue(right, sort.key)
  const direction = sort.direction === 'asc' ? 1 : -1
  const comparison =
    typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : inventorySortCollator.compare(String(leftValue ?? ''), String(rightValue ?? ''))

  if (comparison !== 0) return comparison * direction
  const fallback = inventorySortCollator.compare(left.sku || '', right.sku || '')
  if (fallback !== 0) return fallback
  return toSortNumber(left.id) - toSortNumber(right.id)
}
