import { roundMoney } from '../lib/money';

type BillingInvoiceRowTotalInput = {
  rowTotal: number | string;
  pickPackFee: number | string;
  packageCost: number | string;
  shipping: number | string;
  storage: number | string;
};

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
  return roundMoney(
    Number(input.pickPackFee)
      + Number(input.packageCost)
      + Number(input.shipping)
      + Number(input.storage),
  );
}
