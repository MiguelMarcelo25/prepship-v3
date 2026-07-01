type RateRecord = Record<string, unknown>;

function asRecord(value: unknown): RateRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RateRecord)
    : null;
}

function readFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function readMoneyObjectAmount(value: unknown): number | null {
  const record = asRecord(value);
  return readFiniteNumber(record?.amount);
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const amount = readFiniteNumber(value);
    if (amount != null) return amount;
  }
  return null;
}

function roundMoney(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

export function rateBrowserOtherCostAmount(rate: unknown): number {
  const record = asRecord(rate);
  const raw = asRecord(record?.raw);
  const amount = firstFiniteNumber(
    record?.otherCost,
    record?.other_cost,
    raw?.otherCost,
    raw?.other_cost,
    readMoneyObjectAmount(record?.other_amount),
    readMoneyObjectAmount(raw?.other_amount),
  );
  return roundMoney(amount ?? 0);
}
