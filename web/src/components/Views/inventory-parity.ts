// @ts-nocheck
import type {
  BulkUpdateInventoryDimensionsInput,
  InventoryItemDto,
  ListInventoryLedgerQuery,
} from '../../types/api'

export type InventoryTab = 'stock' | 'receive' | 'clients' | 'history'

export interface InventoryStockFilters {
  search: string
  clientId: string
  alertOnly: boolean
}

export interface ReceiveSkuLookup {
  invSkuId?: number
  name: string
  unitsPerPack: number
}

export interface ReceiveDraftRow {
  id: string
  sku: string
  name: string
  qty: string
  autofilledName: boolean
}

export interface InventoryHistoryFilters {
  clientId: string
  type: string
  from: string
  to: string
}

export function getInventoryDateRangePreset(now: Date = new Date()) {
  const end = new Date(now)
  const start = new Date(now)
  start.setDate(start.getDate() - 30)
  return {
    from: toDateInputValue(start),
    to: toDateInputValue(end),
  }
}

export function toDateInputValue(value: Date) {
  return value.toISOString().slice(0, 10)
}

export function filterInventoryRows(rows: InventoryItemDto[], filters: InventoryStockFilters) {
  const search = filters.search.trim().toLowerCase()
  return rows.filter((row) => {
    if (filters.clientId && String(row.clientId) !== String(filters.clientId)) return false
    if (search && !`${row.sku}${row.name}`.toLowerCase().includes(search)) return false
    if (filters.alertOnly && row.status === 'ok') return false
    return true
  })
}

export function groupInventoryRowsByClient(rows: InventoryItemDto[]) {
  const groups = new Map<number, { clientId: number; clientName: string; rows: InventoryItemDto[] }>()
  for (const row of rows) {
    const existing = groups.get(row.clientId)
    if (existing) {
      existing.rows.push(row)
      continue
    }
    groups.set(row.clientId, {
      clientId: row.clientId,
      clientName: row.clientName,
      rows: [row],
    })
  }
  return Array.from(groups.values())
}

export function getInventoryCuFt(item: InventoryItemDto) {
  if (item.cuFtOverride && item.cuFtOverride > 0) return item.cuFtOverride
  if (item.productLength > 0 && item.productWidth > 0 && item.productHeight > 0) {
    return (item.productLength * item.productWidth * item.productHeight) / 1728
  }
  return 0
}

export function createReceiveDraftRow(): ReceiveDraftRow {
  return {
    id: `recv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sku: '',
    name: '',
    qty: '',
    autofilledName: false,
  }
}

export function applyReceiveSkuInput(row: ReceiveDraftRow, lookup: ReceiveSkuLookup | null): ReceiveDraftRow {
  if (!lookup) {
    return {
      ...row,
      name: row.autofilledName ? '' : row.name,
      autofilledName: false,
    }
  }

  if (!row.name || row.autofilledName) {
    return {
      ...row,
      name: lookup.name,
      autofilledName: true,
    }
  }

  return row
}

export function getReceiveRowHints(row: ReceiveDraftRow, lookup: ReceiveSkuLookup | null) {
  const unitsPerPack = lookup?.unitsPerPack ?? 1
  const qty = Number.parseInt(row.qty, 10) || 0
  return {
    packHint: unitsPerPack > 1 ? `×${unitsPerPack} units/pack` : null,
    totalHint: unitsPerPack > 1 && qty > 0 ? `= ${qty * unitsPerPack} total units` : null,
  }
}

function getReceiveSkuLookup(lookups: Record<string, ReceiveSkuLookup>, sku: string) {
  return lookups[sku]
    ?? Object.entries(lookups).find(([candidate]) => candidate.toLowerCase() === sku.toLowerCase())?.[1]
    ?? null
}

export function buildReceiveItems(rows: ReceiveDraftRow[], lookups: Record<string, ReceiveSkuLookup> = {}) {
  return rows.flatMap((row) => {
    const sku = row.sku.trim()
    const packQty = Number.parseInt(row.qty, 10) || 0
    if (!sku || packQty <= 0) return []
    const lookup = getReceiveSkuLookup(lookups, sku)
    const unitsPerPack = Math.max(1, Number.parseInt(String(lookup?.unitsPerPack ?? 1), 10) || 1)
    const name = row.name.trim()
    return [{
      invSkuId: lookup?.invSkuId,
      sku,
      qty: packQty * unitsPerPack,
      name: name || undefined,
    }]
  })
}

export function buildInventoryLedgerQuery(filters: InventoryHistoryFilters): ListInventoryLedgerQuery {
  const query: ListInventoryLedgerQuery = { limit: 200 }
  if (filters.clientId) query.clientId = Number.parseInt(filters.clientId, 10)
  if (filters.type) query.type = filters.type
  if (filters.from) query.dateStart = new Date(`${filters.from}T00:00:00`).getTime()
  if (filters.to) query.dateEnd = new Date(`${filters.to}T23:59:59`).getTime()
  return query
}

export function buildBulkDimensionUpdates(
  rows: InventoryItemDto[],
  drafts: Record<number, { weightOz: string; productLength: string; productWidth: string; productHeight: string }>
): BulkUpdateInventoryDimensionsInput {
  return {
    updates: rows.map((row) => {
      const draft = drafts[row.id]
      return {
        invSkuId: row.id,
        weightOz: toOptionalNumber(draft?.weightOz),
        productLength: toOptionalNumber(draft?.productLength),
        productWidth: toOptionalNumber(draft?.productWidth),
        productHeight: toOptionalNumber(draft?.productHeight),
      }
    }),
  }
}

function toOptionalNumber(value: string | undefined) {
  if (value == null || value.trim() === '') return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
