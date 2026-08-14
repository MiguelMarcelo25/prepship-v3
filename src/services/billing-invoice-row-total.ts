import { roundMoney } from '../lib/money';

type BillingInvoiceRowTotalInput = {
  rowTotal: number | string;
  pickPackFee: number | string;
  packageCost: number | string;
  shipping: number | string;
  storage: number | string;
  /**
   * PS-505 — return money, counted EXACTLY ONCE.
   *
   * Optional so existing outbound call sites are unchanged; absent reads as 0. A caller
   * that already folds return money into `shipping` must not also pass these, which is
   * precisely the double-count this card removed upstream: return_postage used to feed
   * both the shipping bucket and the dedicated return bucket.
   */
  returnPostage?: number | string | null;
  returnProcessing?: number | string | null;
};

/** Absent reads as 0; an unparseable value must not poison the sum with NaN. */
function amount(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Backend compatibility owner for legacy invoice rows whose aggregate total is
 * zero even though component charges are present.
 */
export function resolveBillingInvoiceRowTotal(input: BillingInvoiceRowTotalInput): number {
  const rowTotal = Number(input.rowTotal);
  // PS-449: a current-period credit is intentionally negative. A zero row is
  // still the legacy compatibility signal that asks for component fallback.
  if (Number.isFinite(rowTotal) && rowTotal !== 0) return roundMoney(rowTotal);

  // Per user override unlock shipped data on 2026-07-14 (Audit B-9): this
  // read-only export fallback now includes the already-generated package-cost
  // line; it does not re-price a box or mutate order/shipment history.
  //
  // PS-505: return money is a term here because it is no longer routed through
  // `shipping`. A Return row reaching this fallback previously summed to zero — every
  // outbound component is zero on it — so a return with a zero persisted row_total
  // exported as $0.00 while its Return Postage and Return Processing cells showed real
  // charges. Persisted nonzero row_total is still authoritative and returns above.
  return roundMoney(
    amount(input.pickPackFee)
      + amount(input.packageCost)
      + amount(input.shipping)
      + amount(input.storage)
      + amount(input.returnPostage)
      + amount(input.returnProcessing),
  );
}
