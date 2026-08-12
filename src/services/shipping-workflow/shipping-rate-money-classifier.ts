/**
 * PS-500 — is a rate's money COMPLETE, decided before anything defaults it.
 *
 * `normalizeShippingRateMoney` and the three normalization sites in
 * `order-rate-dto.ts` all default absent money to zero, and both accept `amount`
 * — a TOTAL — as a shipment-cost COMPONENT. Once that has happened the answer is
 * unrecoverable: a genuine $0.00 and a field the backend never sent are the same
 * number. The Rate Browser then reconstructs `amount - otherCost`, clamps a
 * contradiction to zero with `Math.max`, and seeds a plausible, SELECTABLE row.
 *
 * This module runs FIRST and never substitutes. It records what the payload
 * actually contained, including which key answered, so an `amount`-derived
 * component stays identifiable instead of being laundered into a
 * canonical-looking number.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────────
 * It does not decide usability, selection, persistence, ranking or purchase.
 * Overall selection also depends on quote proof, freshness, eligibility and
 * carrier completeness, which are owned elsewhere. This answers exactly one
 * question — is the MONEY complete — and callers combine that with their own.
 * That is why the verdict is named `rateMoneyComplete` and not `selectable`.
 *
 * Legacy display normalization is deliberately left alone. This sits before it.
 */

/** What the payload actually carried for one money field. */
export type RateMoneyProvenance = 'present' | 'absent' | 'invalid';

export type RateMoneyField = {
  /** The value as supplied. Never defaulted, never derived. */
  value: number | null;
  provenance: RateMoneyProvenance;
  /** Which key answered, so an `amount`-derived component stays identifiable. */
  source: string | null;
};

export type RateMoneyVerdict = {
  shipmentCost: RateMoneyField;
  otherCost: RateMoneyField;
  /** True only when every rule below holds. Money only — not selectability. */
  rateMoneyComplete: boolean;
  /** Stable machine code; null when complete. */
  rateMoneyUnavailableReason: string | null;
  /** Operator-facing text; null when complete. The backend owns this wording. */
  rateMoneyUnavailableMessage: string | null;
};

export const RATE_MONEY_UNAVAILABLE_MESSAGE = 'Saved rate unavailable — browse again';

/**
 * Canonical keys per field, in precedence order.
 *
 * `amount` / `totalCost` are absent on purpose. They are TOTALS. Accepting one
 * as a shipment component is the same category error PS-498 removed from the
 * Rates screen — borrowing a neighbouring field and presenting it as this one.
 */
const SHIPMENT_COST_KEYS = ['shipmentCost', 'shipment_cost'] as const;
const OTHER_COST_KEYS = ['otherCost', 'other_cost'] as const;
/** Explicit totals. Never a component source — only a cross-check against one. */
const TOTAL_KEYS = ['totalCost', 'total_cost', 'amount'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * Read a money field without defaulting.
 *
 * A key that is present but unusable (NaN, a non-numeric string, a boolean)
 * classifies `invalid` rather than `absent`: the backend tried to say something
 * and it did not parse, which is a different fact from silence.
 */
function readMoneyField(
  rate: Record<string, unknown>,
  raw: Record<string, unknown>,
  keys: readonly string[],
): RateMoneyField {
  for (const key of keys) {
    for (const [container, label] of [[rate, key], [raw, `raw.${key}`]] as const) {
      if (!(key in container)) continue;
      const value = container[key];
      if (value === null || value === undefined) continue;
      if (typeof value === 'number') {
        return Number.isFinite(value)
          ? { value, provenance: 'present', source: label }
          : { value: null, provenance: 'invalid', source: label };
      }
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed)
          ? { value: parsed, provenance: 'present', source: label }
          : { value: null, provenance: 'invalid', source: label };
      }
      return { value: null, provenance: 'invalid', source: label };
    }
  }
  return { value: null, provenance: 'absent', source: null };
}

function fail(
  shipmentCost: RateMoneyField,
  otherCost: RateMoneyField,
  reason: string,
): RateMoneyVerdict {
  return {
    shipmentCost,
    otherCost,
    rateMoneyComplete: false,
    rateMoneyUnavailableReason: reason,
    rateMoneyUnavailableMessage: RATE_MONEY_UNAVAILABLE_MESSAGE,
  };
}

/**
 * Classify a rate's money.
 *
 * Zero is FIELD-SPECIFIC, which is the rule the old `?? 0` erased in both
 * directions:
 *   otherCost   0 is VALID and ordinary — most rates carry no add-ons.
 *               absent is NOT 0.
 *   shipmentCost 0 or negative is NOT complete. A shipment cannot cost nothing,
 *               so a zero here is a missing number wearing a plausible face.
 */
export function classifyRateMoney(value: unknown): RateMoneyVerdict {
  const rate = asRecord(value) ?? {};
  const raw = asRecord(rate.raw) ?? {};

  const shipmentCost = readMoneyField(rate, raw, SHIPMENT_COST_KEYS);
  const otherCost = readMoneyField(rate, raw, OTHER_COST_KEYS);

  if (shipmentCost.provenance === 'invalid') {
    return fail(shipmentCost, otherCost, 'shipment_cost_invalid');
  }
  if (shipmentCost.provenance === 'absent') {
    // Never satisfied by `amount`: a total is not this component.
    return fail(shipmentCost, otherCost, 'shipment_cost_absent');
  }
  if (otherCost.provenance === 'invalid') {
    return fail(shipmentCost, otherCost, 'other_cost_invalid');
  }
  if (otherCost.provenance === 'absent') {
    // Absent add-ons are unknown, not zero. Treating them as zero understates
    // the total by exactly the surcharge nobody recorded.
    return fail(shipmentCost, otherCost, 'other_cost_absent');
  }
  if (!(shipmentCost.value! > 0)) {
    return fail(shipmentCost, otherCost, 'shipment_cost_not_positive');
  }
  // An explicit total that contradicts its own components. Reported, never
  // reconciled: silently preferring either side would pick a number nobody sent.
  // Tolerance covers float noise (8.25 + 1.50 vs 9.7499999) without masking a
  // real discrepancy.
  const explicitTotal = readMoneyField(rate, raw, TOTAL_KEYS);
  if (explicitTotal.provenance === 'present') {
    const componentTotal = shipmentCost.value! + otherCost.value!;
    if (Math.abs(componentTotal - explicitTotal.value!) > 0.005) {
      return fail(shipmentCost, otherCost, 'total_contradicts_components');
    }
  }
  if (otherCost.value! < 0) {
    // Previously hidden by Math.max(0, ...), which turned a contradiction into
    // a confident $0.00 on a row the operator could select and buy.
    return fail(shipmentCost, otherCost, 'other_cost_negative');
  }

  return {
    shipmentCost,
    otherCost,
    rateMoneyComplete: true,
    rateMoneyUnavailableReason: null,
    rateMoneyUnavailableMessage: null,
  };
}
