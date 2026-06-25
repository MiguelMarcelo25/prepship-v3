import {
  californiaDateInputValue,
  californiaDayEpochMs,
} from '../../lib/ca-time'

// These inventory DTO/query shapes aren't exported from the shared `types/api`
// shim, so declare the locally-consumed shapes here (matching this module's
// usage). Kept local to avoid touching the shared shim. The item DTO keeps the
// shim's permissive `Record<string, any>` base so ad-hoc inventory-row field
// reads stay type-compatible, with the fields this module relies on pinned.
// TODO PS-257: promote these to canonical exports in types/api.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InventoryItemDto = Record<string, any> & {
  id: number
  clientId: number
  clientName: string
  sku: string
  name: string
  status?: string | null
  active?: boolean | null
  cuFtOverride?: number | null
  // PS-324: backend-owned per-unit cubic feet (storage-fee input). Optional so older
  // deploys that don't stamp it fall back to the legacy override/dims math below.
  cuFt?: number | null
  productLength: number
  productWidth: number
  productHeight: number
}

interface ListInventoryLedgerQuery {
  clientId?: number
  sku?: string
  type?: string
  dateStart?: number
  dateEnd?: number
}

interface BulkUpdateInventoryDimensionsInput {
  updates: Array<{
    invSkuId: number
    weightOz: number | undefined
    productLength: number | undefined
    productWidth: number | undefined
    productHeight: number | undefined
  }>
}

export type InventoryTab = 'stock' | 'receive' | 'clients' | 'history'

export interface InventoryStockFilters {
  search: string
  clientId: string
  alertOnly: boolean
  /**
   * When true, hide SKUs whose `active` flag is false. Defaults to
   * true in the view (only active SKUs visible) — deactivated SKUs
   * are usually archived items operators don't need to see day-to-day.
   * Operators can flip the toolbar toggle off to surface everything.
   */
  activeOnly: boolean
}

export interface ReceiveSkuLookup {
  invSkuId?: number
  name: string
  unitsPerPack: number
  /** 2026-05-15: optional thumbnail URL pulled from the inventory
   *  row's imageUrl column. Surfaced through to the Receive-tab
   *  Autosuggest dropdown so operators can recognize a SKU by its
   *  product photo instead of decoding the SKU code. Null/undefined
   *  when the inventory row has no image — Autosuggest renders an
   *  empty placeholder square in that case to keep row heights
   *  consistent. */
  imageUrl?: string | null
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
  sku?: string
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
  return californiaDateInputValue(value)
}

export function filterInventoryRows(rows: InventoryItemDto[], filters: InventoryStockFilters) {
  const search = filters.search.trim().toLowerCase()
  return rows.filter((row) => {
    if (filters.clientId && String(row.clientId) !== String(filters.clientId)) return false
    if (search && !`${row.sku}${row.name}${row.clientName}`.toLowerCase().includes(search)) return false
    if (filters.alertOnly && row.status === 'ok') return false
    // 2026-05-12: `activeOnly` is now a MUTEX VIEW SWITCH, not a
    // "show/hide" filter. Operators expected the toggle to swap
    // between two distinct views rather than just hide a subset:
    //   - activeOnly === true  → show ONLY active SKUs
    //   - activeOnly === false → show ONLY deactivated SKUs
    //
    // `active` is a tri-state on the wire (true / false / null). We
    // treat null as "active" so legacy rows with no flag set behave
    // like normal active SKUs and don't disappear from the default
    // view.
    if (filters.activeOnly) {
      if (row.active === false) return false
    } else {
      if (row.active !== false) return false
    }
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
  // PS-324: cuFt (a storage-fee input) is now backend-owned — src/lib/inventory-cuft.ts
  // `cuFtPerUnit`, which mirrors the storage-billing formula in src/services/billing.ts so the
  // operator-facing cuFt can never drift from the billed cuFt. Render the backend field; the
  // override/dims math below stays ONLY as a deploy-skew fallback for an older API response
  // that doesn't stamp `cuFt` yet (behavior identical to the old inline computation).
  const backendCuFt = Number(item.cuFt)
  if (Number.isFinite(backendCuFt)) return backendCuFt
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
    const name = row.name.trim()
    // PS-324: send the pack-count INTENT, not a pre-multiplied unit qty. The backend expands
    // packs → units with the canonical units_per_pack, so a stale FE lookup can no longer
    // persist a wrong movement quantity. The ×unitsPerPack expansion remains only as a
    // non-authoritative preview in receiveSummary / getReceiveRowHints.
    return [{
      invSkuId: lookup?.invSkuId,
      sku,
      packs: packQty,
      name: name || undefined,
    }]
  })
}

export function buildInventoryLedgerQuery(filters: InventoryHistoryFilters): ListInventoryLedgerQuery {
  const query: ListInventoryLedgerQuery = {}
  if (filters.clientId) query.clientId = Number.parseInt(filters.clientId, 10)
  if (filters.sku?.trim()) query.sku = filters.sku.trim()
  if (filters.type) query.type = filters.type
  if (filters.from) query.dateStart = californiaDayEpochMs(filters.from)
  if (filters.to) query.dateEnd = californiaDayEpochMs(filters.to, true)
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
