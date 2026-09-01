// PS-514 — the invoice summary category breakdown, owned as a PURE function so it can be
// unit-tested (reconciliation) and shared by the Invoice page. Every money category that
// grandTotal includes must appear here, or the summary cards under-sum the Total — the exact
// defect this card fixes (the page omitted Adjustment + Return while grandTotal summed both,
// and returns are live today).
//
// No React import: a node guard imports this to assert the category union == grandTotal.

export type InvoiceSummaryTotals = {
  pickPackTotal: number
  additionalTotal: number
  packageTotal: number
  shippingTotal: number
  storageTotal: number
  // Rarer categories — optional so a stale API response reads 0 rather than NaN.
  adjustmentTotal?: number
  returnTotal?: number
  replacePostageTotal?: number
  replacePickPackTotal?: number
  grandTotal: number
}

export type InvoiceSummaryCategory = { type: string; amount: number }

function n(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * The category rows for the invoice summary. The always-present operating categories render even
 * at $0 (that is the normal invoice shape). The rarer categories — Adjustment, Return, Replacement
 * — render only when non-zero so a normal invoice is not cluttered. The union of what this returns
 * equals grandTotal (a zero category contributes 0 whether or not it is pushed), which is the
 * reconciliation the page previously broke.
 */
export function buildInvoiceSummaryCategories(totals: InvoiceSummaryTotals): InvoiceSummaryCategory[] {
  const rows: InvoiceSummaryCategory[] = [
    { type: 'Pick & pack', amount: n(totals.pickPackTotal) },
    { type: 'Additional units', amount: n(totals.additionalTotal) },
    { type: 'Package', amount: n(totals.packageTotal) },
    { type: 'Shipping', amount: n(totals.shippingTotal) },
    { type: 'Storage', amount: n(totals.storageTotal) },
  ]
  const adjustment = n(totals.adjustmentTotal)
  if (adjustment !== 0) rows.push({ type: 'Adjustment', amount: adjustment })
  const ret = n(totals.returnTotal)
  if (ret !== 0) rows.push({ type: 'Return', amount: ret })
  const replacement = n(totals.replacePostageTotal) + n(totals.replacePickPackTotal)
  if (replacement !== 0) rows.push({ type: 'Replacement', amount: replacement })
  return rows
}

/** The category union — must equal grandTotal. This is the reconciliation the summary broke. */
export function invoiceSummaryCategoriesSum(totals: InvoiceSummaryTotals): number {
  return buildInvoiceSummaryCategories(totals).reduce((sum, row) => sum + row.amount, 0)
}
