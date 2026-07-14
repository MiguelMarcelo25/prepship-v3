export type RateBackfillConcurrencyInput = {
  liveRateBudget: boolean;
  rateFetchConcurrency: number;
  dbPoolMax: number;
};

function availableBackfillDbConnections(dbPoolMax: number): number {
  const poolSize = Math.max(1, Math.floor(dbPoolMax));
  // Keep one shared connection available for worker heartbeat, queue closeout,
  // and the other bounded worker lanes. A one-connection deployment still has
  // to make forward progress, so its backfill remains serial.
  return poolSize === 1 ? 1 : poolSize - 1;
}

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
      availableBackfillDbConnections(dbPoolMax),
    ),
  );
}

export function resolveRateBackfillDbWriteConcurrency(dbPoolMax: number): number {
  return Math.max(1, Math.min(4, availableBackfillDbConnections(dbPoolMax)));
}
