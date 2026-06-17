// PS-220 — pure decision for a shipment's billed SHIPPING line amount. Extracted from
// billing.ts so the money-committing choice (the worst-case failure is billing the WRONG
// amount) is provable behaviorally, offline, instead of living inline + untested.
//
// Two paths, mutually exclusive:
//   HOUSE (a captured customer_rate is present): bill that customer_rate exactly — the cheapest
//     eligible non-SHIPP rate. NO reference-rate flooring, NO carrier markup. The SHIPP drp_cost
//     (labelCost) is never billed; the spread IS DRP's margin and stays internal.
//   CARRIER (no captured rate): bill the label cost, optionally floored to the cheaper reference
//     rate for non-baseline carriers under reference_rate mode, then the carrier markup (pct + flat).
//
// Pure: numbers/bools in, decision out. The caller (billing.ts) still derives the inputs
// (toNum, SS_BASELINE_CARRIER_CODES.has, the houseCustomerRate map) and builds the row.

export type ShippingLineBillingInput = {
  /** drp_cost: synced shipment cost (+ otherCost). Always the carrier-path basis. */
  labelCost: number;
  /** captured customer_rate for an opted-in SHIPP house order; null/undefined => carrier path. */
  houseCustomerRate: number | null | undefined;
  billingMode: string | null | undefined;
  /** true when the carrier IS an SS baseline carrier (reference-rate flooring then does NOT apply). */
  isBaselineCarrier: boolean;
  refUspsRate: number;
  refUpsRate: number;
  shippingMarkupPct: number;
  shippingMarkupFlat: number;
};

export type ShippingLineBillingResult = {
  /** the amount to bill (raw; caller applies .toFixed(2), matching prior behavior). */
  billedAmount: number;
  source: 'house_customer_rate' | 'reference_rate' | 'label_cost';
  markupApplied: boolean;
  /** description suffix: '' for house/no-markup; ' (P% + $F.FF)' when a carrier markup applies. */
  descriptionSuffix: string;
};

export function decideShippingLineBilling(input: ShippingLineBillingInput): ShippingLineBillingResult {
  // HOUSE: bill the captured customer_rate verbatim; markup + reference-rate suppressed.
  if (input.houseCustomerRate != null) {
    return {
      billedAmount: input.houseCustomerRate,
      source: 'house_customer_rate',
      markupApplied: false,
      descriptionSuffix: '',
    };
  }

  let billedCost = input.labelCost;
  let source: ShippingLineBillingResult['source'] = 'label_cost';
  const mode = input.billingMode ?? 'label_cost';
  if ((mode === 'reference_rate' || mode === 'ss_ref_rate') && !input.isBaselineCarrier) {
    const candidates = [input.refUspsRate, input.refUpsRate].filter((value) => value > 0);
    if (candidates.length > 0) {
      billedCost = Math.max(input.labelCost, Math.min(...candidates));
      source = 'reference_rate';
    }
  }

  const pct = input.shippingMarkupPct;
  const flat = input.shippingMarkupFlat;
  const billedAmount = billedCost * (1 + pct / 100) + flat;
  const markupApplied = pct > 0 || flat > 0;
  return {
    billedAmount,
    source,
    markupApplied,
    descriptionSuffix: markupApplied ? ` (${pct}% + $${flat.toFixed(2)})` : '',
  };
}
