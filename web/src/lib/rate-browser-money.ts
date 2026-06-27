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

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const amount = readFiniteNumber(value);
    if (amount != null) return amount;
  }
  return null;
}

function rawRecord(rate: RateRecord | null): RateRecord | null {
  return asRecord(rate?.raw);
}

function roundMoney(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

export function rateBrowserCustomerAmount(rate: unknown): number {
  const record = asRecord(rate);
  const raw = rawRecord(record);
  const amount = firstFiniteNumber(
    record?.customerRateAmount,
    record?.customer_rate_amount,
    raw?.customerRateAmount,
    raw?.customer_rate_amount,
    record?.amount,
    raw?.amount,
    record?.totalCost,
    raw?.totalCost,
    raw?.total_cost,
  ) ?? 0;
  return roundMoney(amount);
}

export function rateBrowserRateCostAmount(rate: unknown): number {
  const record = asRecord(rate);
  const raw = rawRecord(record);
  const amount = firstFiniteNumber(
    record?.rateCostAmount,
    record?.rate_cost_amount,
    raw?.rateCostAmount,
    raw?.rate_cost_amount,
  ) ?? rateBrowserCustomerAmount(rate);
  return roundMoney(amount);
}

export function rateBrowserHouseAmount(rate: unknown): number | null {
  const record = asRecord(rate);
  const raw = rawRecord(record);
  const amount = firstFiniteNumber(
    record?.houseRateAmount,
    record?.house_rate_amount,
    raw?.houseRateAmount,
    raw?.house_rate_amount,
  );
  return amount == null ? null : roundMoney(amount);
}

function backendDisplayRank(rate: unknown): number | null {
  const record = asRecord(rate);
  const raw = rawRecord(record);
  return firstFiniteNumber(
    record?.backendDisplayRank,
    record?.displayRank,
    record?.rateRank,
    record?.sortRank,
    raw?.backendDisplayRank,
    raw?.displayRank,
    raw?.rateRank,
    raw?.sortRank,
  );
}

export function sortRateRowsByBackendDisplayRank<T>(rates: readonly T[]): T[] {
  return [...rates]
    .map((rate, index) => ({ rate, index }))
    .sort((left, right) => {
      const leftRank = backendDisplayRank(left.rate);
      const rightRank = backendDisplayRank(right.rate);
      if (leftRank != null && rightRank != null && leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      if (leftRank != null && rightRank == null) return -1;
      if (leftRank == null && rightRank != null) return 1;

      const amountDelta = rateBrowserCustomerAmount(left.rate) - rateBrowserCustomerAmount(right.rate);
      return amountDelta || left.index - right.index;
    })
    .map(({ rate }) => rate);
}
