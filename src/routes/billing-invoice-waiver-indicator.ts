/**
 * PS-275 item 2 — the SINGLE owner of the prep-fee WAIVER indicator shown on the
 * billing invoice exports (XLSX, HTML/PDF, CSV).
 *
 * The waiver DECISION is owned by the billing_fee_waivers table and read through
 * readBillingFeeWaivers (the SAME source-of-truth the billing detail view's
 * "Prep fee waived" chip already delegates to). billingInvoiceData turns that
 * decision into a per-order `fee_waived` boolean; these helpers turn that boolean
 * into the user-visible column header + cell text + period note, so all three
 * exports render the indicator IDENTICALLY and can never drift apart.
 *
 * PURE (zero imports, no DB) so the PS-275 guard can exercise it offline. A
 * waived order is now visibly distinguishable from a genuinely free/$0 order.
 */

/** Column title used by all three invoice exports for the waiver indicator. */
export const WAIVED_COLUMN_HEADER = 'Prep Fee Waiver';

/** The per-row cell text: a visible "Waived" marker when this order's prep fee
 *  was waived (zeroed via the $0-shipping review), else an empty string — a
 *  genuinely $0/free order is left blank, so the two are no longer
 *  indistinguishable. */
export function waivedCellText(feeWaived: boolean): string {
  return feeWaived ? 'Waived' : '';
}

/** Period summary note, e.g. "1 order had its prep fee waived ($0.00 prep)."
 *  Returns an empty string when no order in the period was waived, so the
 *  exports stay default-inert (no note) for the common case. */
export function waivedSummaryNote(waivedOrderCount: number): string {
  if (!Number.isFinite(waivedOrderCount) || waivedOrderCount <= 0) return '';
  const noun = waivedOrderCount === 1 ? 'order had its' : 'orders had their';
  return `${waivedOrderCount} ${noun} prep fee waived ($0.00 prep).`;
}
