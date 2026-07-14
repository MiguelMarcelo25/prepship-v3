export type RateBackfillConcurrencyInput = {
  liveRateBudget: boolean;
  rateFetchConcurrency: number;
  dbPoolMax: number;
};

export function resolveRateBackfillConcurrency({
  liveRateBudget,
  rateFetchConcurrency,
  dbPoolMax,
}: RateBackfillConcurrencyInput): number {
  const desiredConcurrency = liveRateBudget ? 2 : 4;
  return Math.max(
    1,
    Math.min(
      desiredConcurrency,
      Math.max(1, Math.floor(rateFetchConcurrency)),
      Math.max(1, Math.floor(dbPoolMax)),
    ),
  );
}
