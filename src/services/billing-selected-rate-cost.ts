import { normalizeShippingRateMoney } from './shipping-workflow/shipping-rate-money-normalizer';

export type BillingSelectedRateCostInput = {
  // PS-370: the persisted normalized total (shipments.selected_rate_cost). When
  // present it wins — TS and SQL then read ONE value. NULL (un-backfilled) falls
  // through to the component derivation below, so this is byte-identical today.
  selectedRateCost?: unknown;
  cost?: unknown;
  labelCost?: unknown;
  otherCost?: unknown;
  selectedRateJson?: unknown;
};

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstNumber(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = toFiniteNumber(record[key]);
    if (value != null) return value;
  }
  return null;
}

function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function resolveBillingSelectedRateCost(input: BillingSelectedRateCostInput): number | null {
  // PS-370: the persisted column is the source of truth when present.
  const persisted = toFiniteNumber(input.selectedRateCost);
  if (persisted != null) return roundCents(persisted);

  // NULL column (un-backfilled row) -> the component derivation, UNCHANGED. The
  // card's Phase-1 note to collapse this to normalizeShippingRateMoney is
  // deferred: the normalizer reads otherCost from money-OBJECTS ({amount}) while
  // this reads a plain otherCost number, so collapsing would drop insurance/other
  // on un-backfilled rows and change billed totals — barred by "NEVER change
  // amounts". After the Phase-2 backfill this fallback becomes NULL-safety only
  // and can be deleted safely.
  const selectedRate = recordOrNull(input.selectedRateJson);
  const otherCost =
    toFiniteNumber(input.otherCost) ??
    firstNumber(selectedRate, ['otherCost', 'other_cost', 'insuranceCost', 'insurance_cost']) ??
    0;
  const postageCost =
    toFiniteNumber(input.cost) ??
    toFiniteNumber(input.labelCost) ??
    firstNumber(selectedRate, ['shipmentCost', 'shipment_cost', 'labelCost', 'label_cost']);

  if (postageCost != null) return roundCents(postageCost + otherCost);

  const selectedTotal = normalizeShippingRateMoney(selectedRate).selectedRateCost;
  return selectedTotal != null ? roundCents(selectedTotal) : null;
}
