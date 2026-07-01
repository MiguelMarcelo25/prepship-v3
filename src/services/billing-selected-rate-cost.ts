export type BillingSelectedRateCostInput = {
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
  const selectedRate = recordOrNull(input.selectedRateJson);
  const otherCost =
    toFiniteNumber(input.otherCost) ??
    firstNumber(selectedRate, ['otherCost', 'other_cost', 'insuranceCost', 'insurance_cost']) ??
    0;
  const postageCost =
    toFiniteNumber(input.cost) ??
    toFiniteNumber(input.labelCost) ??
    firstNumber(selectedRate, ['shipmentCost', 'shipment_cost', 'labelCost', 'label_cost', 'rateCostAmount']);

  if (postageCost != null) return roundCents(postageCost + otherCost);

  const selectedTotal = firstNumber(selectedRate, ['totalCost', 'total_cost']);
  return selectedTotal != null ? roundCents(selectedTotal) : null;
}
