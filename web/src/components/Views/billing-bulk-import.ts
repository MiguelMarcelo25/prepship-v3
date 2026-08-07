// PS — pasted billing corrections (Order # / Box / Shipping).
//
// Pure parsing + resolution ONLY. This file decides nothing about money: it turns
// pasted text into an explicit, reviewable intent, and every row is written through
// the existing audited PATCH /billing/details/:orderId endpoint. Editability
// (finalized invoices, permissions) stays a backend decision — a row this file marks
// `ready` can still be refused by the API, and the modal reports that verbatim.

export type BulkImportParsedRow = {
  lineNumber: number
  orderNumberRaw: string
  boxRaw: string
  shippingRaw: string
}

export type BulkImportStatus =
  | 'ready'
  | 'unknown_order'
  | 'unknown_box'
  | 'ambiguous_box'
  | 'bad_shipping'
  | 'duplicate'
  | 'nothing_to_change'

export type BulkImportResolvedRow = {
  lineNumber: number
  orderNumberRaw: string
  orderId: number | null
  packageId: number | null
  packageName: string | null
  shipping: number | null
  status: BulkImportStatus
  detail: string
}

type LooseRow = Record<string, unknown>

/** Alphanumerics only, lowercased: "12 x 10 x 3" and "12x10x3" compare equal. */
function normalizeKey(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Accepts "$20.83", " 20.72 ", "1,234.56". Refuses anything ambiguous.
 *
 * A comma is ONLY a thousands separator. Stripping commas blindly turns the
 * European decimal "20,83" into 2083 — a 100x overcharge written onto a real
 * invoice — so a comma that isn't grouping three digits rejects the row instead.
 */
export function parseImportMoney(raw: string): number | null {
  const cleaned = String(raw ?? '').replace(/[$\s]/g, '')
  if (!cleaned) return null

  let digits = cleaned
  if (digits.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits)) return null
    digits = digits.replace(/,/g, '')
  }

  if (!/^\d+(\.\d+)?$/.test(digits)) return null
  const amount = Number(digits)
  if (!Number.isFinite(amount) || amount < 0) return null
  return amount
}

/**
 * Accepts a paste from Google Sheets (tab-separated) or CSV.
 * Column order is fixed: Order #, Box, Shipping. Box and Shipping may be blank —
 * a blank column means "leave that field alone".
 */
export function parseBulkImportText(text: string): BulkImportParsedRow[] {
  const out: BulkImportParsedRow[] = []
  const lines = String(text ?? '').split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!line.trim()) return
    const cells = (line.includes('\t') ? line.split('\t') : line.split(',')).map((cell) => cell.trim())
    const [orderNumberRaw = '', boxRaw = '', shippingRaw = ''] = cells
    // Skip a pasted header row.
    if (index === 0 && /order/i.test(orderNumberRaw) && !/^\d+$/.test(orderNumberRaw)) return
    if (!orderNumberRaw) return
    out.push({ lineNumber: index + 1, orderNumberRaw, boxRaw, shippingRaw })
  })
  return out
}

/**
 * Match a pasted box name to exactly one package. Exact normalized name wins; a
 * unique substring match is accepted; anything ambiguous is reported, never picked.
 */
export function resolveImportPackage(
  boxRaw: string,
  packages: LooseRow[],
): { packageId: number | null; packageName: string | null; status: 'ok' | 'unknown' | 'ambiguous' } {
  const needle = normalizeKey(boxRaw)
  if (!needle) return { packageId: null, packageName: null, status: 'unknown' }

  const withKeys = packages.map((pkg) => ({
    pkg,
    id: Number(pkg.packageId ?? pkg.id),
    name: String(pkg.name ?? ''),
    key: normalizeKey(pkg.name ?? pkg.packageId ?? pkg.id),
  })).filter((entry) => Number.isFinite(entry.id))

  const exact = withKeys.filter((entry) => entry.key === needle)
  if (exact.length > 1) return { packageId: null, packageName: null, status: 'ambiguous' }
  const exactHit = exact[0]
  if (exactHit) return { packageId: exactHit.id, packageName: exactHit.name, status: 'ok' }

  const partial = withKeys.filter((entry) => entry.key.includes(needle))
  if (partial.length > 1) return { packageId: null, packageName: null, status: 'ambiguous' }
  const partialHit = partial[0]
  if (partialHit) return { packageId: partialHit.id, packageName: partialHit.name, status: 'ok' }

  return { packageId: null, packageName: null, status: 'unknown' }
}

/**
 * Resolve pasted rows against the loaded billing detail rows and the package list.
 * Nothing here writes; the caller applies only rows whose status is `ready`.
 */
export function resolveBulkImportRows(
  parsed: BulkImportParsedRow[],
  detailRows: LooseRow[],
  packages: LooseRow[],
): BulkImportResolvedRow[] {
  const byOrderNumber = new Map<string, LooseRow>()
  for (const row of detailRows) {
    const key = normalizeKey(row.orderNumber ?? row.order_number)
    if (key && !byOrderNumber.has(key)) byOrderNumber.set(key, row)
  }

  const seen = new Set<string>()

  return parsed.map((row) => {
    const base = {
      lineNumber: row.lineNumber,
      orderNumberRaw: row.orderNumberRaw,
      orderId: null as number | null,
      packageId: null as number | null,
      packageName: null as string | null,
      shipping: null as number | null,
    }

    const orderKey = normalizeKey(row.orderNumberRaw)
    if (seen.has(orderKey)) {
      return { ...base, status: 'duplicate' as const, detail: 'Order appears more than once in this paste' }
    }
    seen.add(orderKey)

    const match = byOrderNumber.get(orderKey)
    if (!match) {
      return { ...base, status: 'unknown_order' as const, detail: 'Not in the loaded billing range' }
    }
    const orderId = Number(match.orderId ?? match.order_id)
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return { ...base, status: 'unknown_order' as const, detail: 'Matched row has no usable order id' }
    }

    let packageId: number | null = null
    let packageName: string | null = null
    if (row.boxRaw) {
      const box = resolveImportPackage(row.boxRaw, packages)
      if (box.status === 'unknown') {
        return { ...base, orderId, status: 'unknown_box' as const, detail: `No box matches "${row.boxRaw}"` }
      }
      if (box.status === 'ambiguous') {
        return { ...base, orderId, status: 'ambiguous_box' as const, detail: `"${row.boxRaw}" matches more than one box` }
      }
      packageId = box.packageId
      packageName = box.packageName
    }

    let shipping: number | null = null
    if (row.shippingRaw) {
      shipping = parseImportMoney(row.shippingRaw)
      if (shipping == null) {
        return { ...base, orderId, packageId, packageName, status: 'bad_shipping' as const, detail: `"${row.shippingRaw}" is not a valid amount` }
      }
    }

    if (packageId == null && shipping == null) {
      return { ...base, orderId, status: 'nothing_to_change' as const, detail: 'No box and no shipping given' }
    }

    return {
      ...base,
      orderId,
      packageId,
      packageName,
      shipping,
      status: 'ready' as const,
      detail: '',
    }
  })
}

/**
 * A row that resolved cleanly. `orderId` is non-null by construction, so callers
 * need no scope/shape gate of their own before applying it — the backend remains
 * the only thing deciding whether the edit is actually allowed.
 */
export type BulkImportReadyRow = Omit<BulkImportResolvedRow, 'orderId' | 'status'> & {
  orderId: number
  status: 'ready'
}

export function bulkImportReadyRows(rows: BulkImportResolvedRow[]): BulkImportReadyRow[] {
  return rows.filter(
    (row): row is BulkImportReadyRow => row.status === 'ready' && typeof row.orderId === 'number',
  )
}

export const BULK_IMPORT_STATUS_LABEL: Record<BulkImportStatus, string> = {
  ready: 'Ready',
  unknown_order: 'Order not found',
  unknown_box: 'Box not found',
  ambiguous_box: 'Box ambiguous',
  bad_shipping: 'Bad amount',
  duplicate: 'Duplicate',
  nothing_to_change: 'Nothing to change',
}
