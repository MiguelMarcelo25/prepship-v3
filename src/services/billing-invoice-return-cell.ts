/**
 * PS-488 M3 — the ONE owner of "did this return actually get charged this fee?"
 *
 * A return fee has three states on an invoice, and the first two share a number:
 *
 *   ABSENT       the return was never charged this fee  → no cell value at all
 *   PRESENT ZERO the return was charged, at $0.00       → 0
 *   PRESENT      the return was charged some amount     → the amount
 *
 * Reading the amount alone cannot separate ABSENT from PRESENT ZERO, so a processing-only
 * return printed "$0.00 postage" — a charge that was never made, on a document a client
 * is billed from, indistinguishable from a postage charge that was genuinely waived.
 *
 * Every serializer resolves through here rather than testing `?? 0` itself. Three
 * renderers (HTML, XLSX, CSV) previously each decided independently, and two of the three
 * got it wrong in the same way. One owner returning `number | null` lets each renderer
 * make only a FORMATTING decision — em-dash, blank cell, empty string — with the
 * three-state question already answered identically for all of them.
 *
 * Pure: no I/O, no DB, no formatting. Amount and presence in, `number | null` out.
 */

export type BillingInvoiceReturnFeeInput = {
  /**
   * Whether the fee LINE existed. Undefined is treated as absent on purpose: a caller
   * that has not been taught about presence yet must not silently assert that every
   * return was charged both fees.
   */
  present?: boolean | null;
  /** The persisted amount. Only consulted when the fee is present. */
  amount?: string | number | null;
};

/**
 * @returns the numeric amount when the fee exists (including a real 0), or null when the
 * fee was never charged. Never NaN: a present-but-unparseable amount resolves to 0, since
 * the line's existence is the fact being asserted and a NaN would render as a broken cell
 * rather than a wrong one.
 */
export function resolveBillingInvoiceReturnFee(input: BillingInvoiceReturnFeeInput): number | null {
  if (input.present !== true) return null;
  const amount = Number(input.amount ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}
