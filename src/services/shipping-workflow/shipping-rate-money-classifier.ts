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

// Summing the structured add-ons produces cents, and `roundMoney` is this
// repo's single named cent-rounding owner — it implements a documented
// symmetric half-cent policy that `Math.round(v * 100) / 100` does not match on
// negatives. Enforced by test:audit-money-rounding.
import { roundMoney } from '../../lib/money.js';

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
 * Flat keys per field, in precedence order. These are the persisted/normalized
 * shape — `best_rate_json`, DTO rows, anything already through our own mapping.
 *
 * A bare `amount` is absent on purpose and stays absent: it is not a documented
 * component in any payload we accept, and accepting it as the shipment cost is
 * the same category error PS-498 removed from the Rates screen — borrowing a
 * neighbouring field and presenting it as this one.
 */
const SHIPMENT_COST_KEYS = ['shipmentCost', 'shipment_cost'] as const;
const OTHER_COST_KEYS = ['otherCost', 'other_cost'] as const;

/**
 * The provider shape. ShipEngine/ShipStation rates carry money as
 * `{ currency, amount }` objects, and `src/lib/shipstation/types.ts` declares
 * the contract this reads:
 *
 *   shipping_amount       REQUIRED   the shipment component
 *   other_amount?         optional
 *   confirmation_amount?  optional   the add-ons, summed
 *   insurance_amount?     optional
 *
 * The first version of this module knew only the flat keys, so every live rate
 * classified `shipment_cost_absent` and the whole browse path went unavailable.
 * A fail-closed check turns "I cannot read this" into "this is unsafe" — so a
 * vocabulary gap became an outage. The rules about what must never be INVENTED
 * are unchanged; only what can be READ is wider.
 */
const STRUCTURED_SHIPMENT_KEY = 'shipping_amount';
const STRUCTURED_OTHER_KEYS = ['other_amount', 'confirmation_amount', 'insurance_amount'] as const;

/**
 * Documented totals, used only to cross-check components — never as a source.
 *
 * A bare `amount` is NOT here. Providers use it inconsistently, and
 * `shipping-rate-money-normalizer.ts:123` reads it as a shipment COMPONENT.
 * Treating it as a total made correct rows contradict themselves.
 */
const TOTAL_KEYS = ['totalCost', 'total_cost', 'selectedRateCost', 'selected_rate_cost'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

const ABSENT: RateMoneyField = { value: null, provenance: 'absent', source: null };

/**
 * Turn one carried value into a field, without defaulting.
 *
 * A value that is present but unusable (NaN, a non-numeric string, a boolean)
 * classifies `invalid` rather than `absent`: the backend tried to say something
 * and it did not parse, which is a different fact from silence.
 */
function coerceMoney(value: unknown, label: string): RateMoneyField {
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
      return coerceMoney(value, label);
    }
  }
  return ABSENT;
}

/** One `{ currency, amount }` object, or null when the key is not carried. */
function readMoneyObject(
  rate: Record<string, unknown>,
  raw: Record<string, unknown>,
  key: string,
): RateMoneyField | null {
  for (const [container, label] of [[rate, key], [raw, `raw.${key}`]] as const) {
    if (!(key in container)) continue;
    const value = container[key];
    if (value === null || value === undefined) continue;
    const object = asRecord(value);
    if (object) {
      if (!('amount' in object)) continue;
      const amount = object.amount;
      if (amount === null || amount === undefined) {
        return { value: null, provenance: 'invalid', source: `${label}.amount` };
      }
      return coerceMoney(amount, `${label}.amount`);
    }
    // Flattened to a bare scalar. Same documented field, same authority — the
    // currency wrapper is presentation, not provenance.
    return coerceMoney(value, label);
  }
  return null;
}

/**
 * Reports WHICH convention answered as an explicit fact, not as something to be
 * re-derived from `source`. That label is an audit trail for humans; deciding
 * control flow by pattern-matching it is how the flattened-scalar form silently
 * stopped counting as structured.
 */
function readShipmentCost(
  rate: Record<string, unknown>,
  raw: Record<string, unknown>,
): { field: RateMoneyField; structured: boolean } {
  const flat = readMoneyField(rate, raw, SHIPMENT_COST_KEYS);
  if (flat.provenance !== 'absent') return { field: flat, structured: false };
  const structured = readMoneyObject(rate, raw, STRUCTURED_SHIPMENT_KEY);
  return structured ? { field: structured, structured: true } : { field: ABSENT, structured: false };
}

/**
 * Add-ons.
 *
 * Flat wins when carried. Otherwise the structured trio is summed — but ONLY
 * when the shipment component itself came from the structured shape, proving
 * the payload speaks that convention. Inside that convention an omitted add-on
 * means the carrier did not charge it, which the type contract states; reading
 * it as zero is reading the contract, not defaulting.
 *
 * A FLAT payload never gets that treatment. There, silence about add-ons is
 * genuinely unknown, and unknown stays incomplete — that is the original
 * `?? 0` defect and it remains closed.
 */
function readOtherCost(
  rate: Record<string, unknown>,
  raw: Record<string, unknown>,
  shipmentIsStructured: boolean,
): RateMoneyField {
  const flat = readMoneyField(rate, raw, OTHER_COST_KEYS);
  if (flat.provenance !== 'absent') return flat;
  if (!shipmentIsStructured) return ABSENT;

  let total = 0;
  const sources: string[] = [];
  for (const key of STRUCTURED_OTHER_KEYS) {
    const field = readMoneyObject(rate, raw, key);
    if (!field) continue;
    if (field.provenance === 'invalid') return field;
    // A negative component is surfaced on its own, not netted away by a larger
    // positive sibling — the sum could look ordinary while one line is wrong.
    if (field.value! < 0) return field;
    total += field.value!;
    sources.push(field.source!);
  }
  return sources.length > 0
    ? { value: roundMoney(total), provenance: 'present', source: sources.join(' + ') }
    : { value: 0, provenance: 'present', source: `${STRUCTURED_SHIPMENT_KEY} (no add-on fields carried)` };
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

  // `structured` says the payload speaks the provider's convention, which is
  // what licenses reading an omitted add-on as "not charged".
  const { field: shipmentCost, structured: shipmentIsStructured } = readShipmentCost(rate, raw);
  const otherCost = readOtherCost(rate, raw, shipmentIsStructured);

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
  if (otherCost.value! < 0) {
    // Previously hidden by Math.max(0, ...), which turned a contradiction into
    // a confident $0.00 on a row the operator could select and buy. Checked
    // before the total so a bad line is named as such rather than surfacing as
    // an arithmetic disagreement.
    return fail(shipmentCost, otherCost, 'other_cost_negative');
  }
  // A DOCUMENTED total that contradicts its own components. Reported, never
  // reconciled: silently preferring either side would pick a number nobody sent.
  // Tolerance covers float noise (8.25 + 1.50 vs 9.7499999) without masking a
  // real discrepancy. Bare `amount` is deliberately not consulted here — see
  // TOTAL_KEYS.
  const explicitTotal = readMoneyField(rate, raw, TOTAL_KEYS);
  if (explicitTotal.provenance === 'present') {
    const componentTotal = shipmentCost.value! + otherCost.value!;
    if (Math.abs(componentTotal - explicitTotal.value!) > 0.005) {
      return fail(shipmentCost, otherCost, 'total_contradicts_components');
    }
  }

  return {
    shipmentCost,
    otherCost,
    rateMoneyComplete: true,
    rateMoneyUnavailableReason: null,
    rateMoneyUnavailableMessage: null,
  };
}
