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
  descriptionRaw: string
}

export type BulkImportStatus =
  | 'ready'
  | 'unknown_order'
  | 'unknown_box'
  | 'ambiguous_box'
  | 'bad_shipping'
  | 'bad_description'
  | 'duplicate'
  | 'nothing_to_change'

export type BulkImportResolvedRow = {
  lineNumber: number
  orderNumberRaw: string
  orderId: number | null
  packageId: number | null
  packageName: string | null
  shipping: number | null
  /**
   * PS-498 — the operator's per-order description, trimmed. Empty string when the
   * row carries none. Distinct from `detail`, which is this file's explanation of
   * a status; this is the human's own sentence and it travels to the API, the
   * database and the Edit modal under this one name.
   */
  description: string
  status: BulkImportStatus
  detail: string
}

/**
 * PS-498 — the shortest description we will send. The description REPLACES the
 * shared reason for its row, and the API's `reason` is `min(3)`. Checking it here
 * means a 2-character description is refused in the grid, instead of sailing
 * through and returning a server 400 about a "reason" the operator never typed.
 */
const MIN_DESCRIPTION_LENGTH = 3

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
 * Column order is fixed: Order #, Box, Shipping, Description. Any column may be
 * blank — a blank Box or Shipping means "leave that field alone", and a blank
 * Description means the shared fallback reason applies to that row.
 */
/**
 * Split one line into [order, box, shipping, description].
 *
 * A SPACE-SEPARATED LINE NEVER YIELDS A DESCRIPTION, and that is a refusal rather
 * than an oversight. Once both the box and the description may contain spaces,
 * "2555 12x10x3 20.72 Canada re-ship" is genuinely undecidable — "Canada re-ship"
 * is indistinguishable from a box named "Custom 12x10x3". Any heuristic here is a
 * guess, and a wrong guess writes the wrong box onto a real invoice. Instead the
 * tail is swallowed into the box, no package matches, and the row refuses with
 * "Box not found" — loud, and nothing is written. Paste with tabs or commas
 * (which is what Sheets and CSV produce anyway), or type into the Description cell.
 *
 * Tabs and commas are unambiguous separators. Plain spaces are not — a box can
 * legitimately be "Custom 12x10x3" — so for a space-separated line we anchor on
 * the ends instead: first token is the order, a trailing money-looking token is
 * the shipping, and whatever remains in the middle is the box.
 */
function splitImportLine(line: string): [string, string, string, string] {
  if (line.includes('\t')) {
    const cells = line.split('\t')
    const [a = '', b = '', c = ''] = cells.map((cell) => cell.trim())
    // Join the tail rather than taking cells[3], so a stray extra tab typed
    // inside the description truncates nothing.
    return [a, b, c, cells.slice(3).join(' ').trim()]
  }
  if (line.includes(',')) {
    const parts = line.split(',')
    const [a = '', b = '', c = ''] = parts.map((cell) => cell.trim())
    // Only the FIRST THREE commas are separators — a description legitimately
    // contains commas ("Canada re-ship, external Unishippers cost"). Slice the
    // ORIGINAL string past the third comma instead of re-joining trimmed parts,
    // so interior spacing survives exactly as typed. A line with <=3 fields
    // yields '' here and behaves byte-identically to before.
    const head = parts.slice(0, 3).join(',')
    return [a, b, c, parts.length > 3 ? line.slice(head.length + 1).trim() : '']
  }

  const tokens = line.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ['', '', '', '']
  const order = tokens[0]!
  const rest = tokens.slice(1)
  if (rest.length === 0) return [order, '', '', '']

  const last = rest[rest.length - 1]!
  if (parseImportMoney(last) != null) {
    return [order, rest.slice(0, -1).join(' '), last, '']
  }
  return [order, rest.join(' '), '', '']
}

export function parseBulkImportText(text: string): BulkImportParsedRow[] {
  const out: BulkImportParsedRow[] = []
  const lines = String(text ?? '').split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!line.trim()) return
    const [orderNumberRaw, boxRaw, shippingRaw, descriptionRaw] = splitImportLine(line)
    // Skip a pasted header row. Tests the FIRST cell only, so a header carrying a
    // fourth "Description" column still skips.
    if (index === 0 && /order/i.test(orderNumberRaw) && !/^\d+$/.test(orderNumberRaw)) return
    if (!orderNumberRaw) return
    out.push({ lineNumber: index + 1, orderNumberRaw, boxRaw, shippingRaw, descriptionRaw })
  })
  return out
}

/**
 * Build parsed rows from the grid's own fields. No separator guessing is needed
 * here — the operator already put each value in its own input.
 */
export function bulkImportRowsFromFields(
  fields: Array<{
    orderNumberRaw: string
    boxRaw: string
    shippingRaw: string
    descriptionRaw?: string
  }>,
): BulkImportParsedRow[] {
  const out: BulkImportParsedRow[] = []
  fields.forEach((field, index) => {
    const orderNumberRaw = String(field.orderNumberRaw ?? '').trim()
    const boxRaw = String(field.boxRaw ?? '').trim()
    const shippingRaw = String(field.shippingRaw ?? '').trim()
    const descriptionRaw = String(field.descriptionRaw ?? '').trim()
    // A wholly empty row is the operator's blank line, not an error. The
    // description MUST be part of this test: without it, typing only a
    // description makes the row vanish from the resolved list and the operator
    // sees no status at all for text they just typed.
    if (!orderNumberRaw && !boxRaw && !shippingRaw && !descriptionRaw) return
    out.push({ lineNumber: index + 1, orderNumberRaw, boxRaw, shippingRaw, descriptionRaw })
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
    const description = String(row.descriptionRaw ?? '').trim()
    const base = {
      lineNumber: row.lineNumber,
      orderNumberRaw: row.orderNumberRaw,
      orderId: null as number | null,
      packageId: null as number | null,
      packageName: null as string | null,
      shipping: null as number | null,
      // Set in `base` so EVERY branch below — including the refusals — carries the
      // operator's text back to the grid, and so it reaches BulkImportReadyRow for
      // free via the Omit<> below.
      description,
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

    // Placed AFTER box/shipping so the common problems surface first — an operator
    // fixing one thing per round trip is the failure this ordering avoids.
    if (description && description.length < MIN_DESCRIPTION_LENGTH) {
      return {
        ...base,
        orderId,
        packageId,
        packageName,
        shipping,
        status: 'bad_description' as const,
        detail: `Description must be at least ${MIN_DESCRIPTION_LENGTH} characters`,
      }
    }

    if (packageId == null && shipping == null) {
      // A description alone is deliberately NOT an edit. Applying a row re-sends
      // the whole invoice line at its current values, which would mint durable
      // manual overrides for three line types that did not previously exist —
      // turning "add a note" into "pin three amounts that survive regeneration".
      return {
        ...base,
        orderId,
        status: 'nothing_to_change' as const,
        detail: description
          ? 'A description alone is not an invoice edit — add a Box or Shipping'
          : 'No box and no shipping given',
      }
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
  bad_description: 'Description too short',
  duplicate: 'Duplicate',
  nothing_to_change: 'Nothing to change',
}

/**
 * PS-498 — which reason a ready row is applied with. The ONE home for the
 * precedence rule: the row's own description wins, the shared box is the fallback
 * for rows without one, and `null` means the row cannot be applied yet.
 *
 * Consumed by BOTH the Apply button's enable-gate and the apply loop. That is the
 * point of it being a function rather than two expressions: a gate that disagrees
 * with the send path either blocks work that would have succeeded, or sends a
 * request the server rejects for a reason the operator cannot see.
 */
export function bulkImportReasonFor(
  row: Pick<BulkImportResolvedRow, 'description'>,
  sharedReason: string,
): string | null {
  const own = String(row.description ?? '').trim()
  if (own.length >= MIN_DESCRIPTION_LENGTH) return own
  const shared = String(sharedReason ?? '').trim()
  return shared.length >= MIN_DESCRIPTION_LENGTH ? shared : null
}
