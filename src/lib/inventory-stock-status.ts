// Canonical In / Low / Out-of-Stock classification + the Dashboard inventory snapshot.
//
// PS-325: the Dashboard inventory KPIs (In Stock / Low Stock / Out of Stock counts + %) used to be
// DEFINED in React — DashboardView aggregated them with inline `.filter()` threshold math, making
// the frontend a silent second source of truth for what "low stock" means. This module is the ONE
// backend owner of the stock-status thresholds: the /dashboard/inventory-risk route computes the
// snapshot from it, and the Dashboard renders the result. Like src/lib/inventory-reorder-policy
// (PS-150), it is pure and shared by both the backend route and the frontend (the FE uses it only
// as a deploy-skew fallback), so the definition can never drift between layers.

export type StockStatus = 'in' | 'low' | 'out'

function toNum(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

// THE definition of stock status. stock <= 0 => out; 0 < stock <= minStock => low; otherwise in.
export function classifyStockStatus(stock: number, minStock: number): StockStatus {
  if (stock <= 0) return 'out'
  if (stock <= minStock) return 'low'
  return 'in'
}

// Inventory rows expose one backend-owned signed ledger quantity and one reorder threshold.
export interface StockCountInput {
  inventoryQuantity: unknown
  reorderLevel?: unknown
}

export interface InventorySnapshot {
  inStock: number
  lowStock: number
  outOfStock: number
  totalSkus: number
  // Self-describing provenance so consumers never re-derive the rule (PS-325).
  definition: { out: string; low: string; in: string }
  // ISO instant the backend computed the snapshot, or null when client-derived (deploy-skew
  // fallback) — missing freshness is labeled, not fabricated.
  computedAt: string | null
}

const SNAPSHOT_DEFINITION = {
  out: 'stock <= 0',
  low: '0 < stock <= minStock',
  in: 'stock > minStock',
} as const

// Bucket a set of inventory rows into the In/Low/Out snapshot using the canonical classifier.
// `totalSkus` is the size of the set the caller passed (the dashboard fetches active SKUs); it is
// not an unbounded COUNT(*) — see the route for the pageSize note.
export function summarizeInventorySnapshot(
  items: ReadonlyArray<StockCountInput>,
  computedAt: string | null = null,
): InventorySnapshot {
  let inStock = 0
  let lowStock = 0
  let outOfStock = 0
  for (const item of items) {
    const stock = toNum(item.inventoryQuantity)
    const minStock = toNum(item.reorderLevel)
    const status = classifyStockStatus(stock, minStock)
    if (status === 'out') outOfStock += 1
    else if (status === 'low') lowStock += 1
    else inStock += 1
  }
  return {
    inStock,
    lowStock,
    outOfStock,
    totalSkus: items.length,
    definition: { ...SNAPSHOT_DEFINITION },
    computedAt,
  }
}
