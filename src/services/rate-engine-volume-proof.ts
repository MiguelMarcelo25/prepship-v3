export type RateEngineVolumeProofInput = {
  selectedOrders: number;
  visibleShipStationAccounts: number;
  visibleDirectCarrierAccounts: number;
  rateFetchConcurrency: number;
  directCarrierConcurrency: number;
  backfillOrderConcurrency: number;
  awaitingPageLoadProviderCalls: number;
  usesRateBrowseSingleFlight: boolean;
  usesCacheFirstOpenPreview: boolean;
  pendingHeartbeatMs: number;
  pendingStaleWindowMs: number;
};

export type RateEngineVolumeProof = {
  selectedOrders: number;
  awaitingPageLoadProviderCalls: number;
  cacheFirstOpenPreview: boolean;
  liveBrowseSingleFlight: boolean;
  maxConcurrentBackfillOrders: number;
  maxShipStationCarrierCalls: number;
  maxDirectCarrierCalls: number;
  pendingHeartbeatSafe: boolean;
  requestCountSummary: string;
};

function positiveInt(value: number, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function buildRateEngineVolumeProof(input: RateEngineVolumeProofInput): RateEngineVolumeProof {
  const selectedOrders = nonNegativeInt(input.selectedOrders);
  const visibleShipStationAccounts = nonNegativeInt(input.visibleShipStationAccounts);
  const visibleDirectCarrierAccounts = nonNegativeInt(input.visibleDirectCarrierAccounts);
  const rateFetchConcurrency = positiveInt(input.rateFetchConcurrency, 1);
  const directCarrierConcurrency = positiveInt(input.directCarrierConcurrency, 1);
  const backfillOrderConcurrency = positiveInt(input.backfillOrderConcurrency, 1);
  const maxConcurrentBackfillOrders = Math.min(selectedOrders, backfillOrderConcurrency);

  // ShipStation fan-out is globally limited inside src/services/rates.ts, so
  // two active backfill workers still share one backend ShipStation permit pool.
  const maxShipStationCarrierCalls = Math.min(visibleShipStationAccounts, rateFetchConcurrency);

  // Direct carriers have a per-order direct-carrier cap. The batch order worker
  // cap bounds how many of those per-order direct fan-outs can be active.
  const maxDirectCarrierCalls =
    maxConcurrentBackfillOrders * Math.min(visibleDirectCarrierAccounts, directCarrierConcurrency);

  const pendingHeartbeatSafe =
    input.pendingHeartbeatMs > 0 &&
    input.pendingStaleWindowMs > 0 &&
    input.pendingHeartbeatMs < input.pendingStaleWindowMs;

  return {
    selectedOrders,
    awaitingPageLoadProviderCalls: nonNegativeInt(input.awaitingPageLoadProviderCalls),
    cacheFirstOpenPreview: input.usesCacheFirstOpenPreview,
    liveBrowseSingleFlight: input.usesRateBrowseSingleFlight,
    maxConcurrentBackfillOrders,
    maxShipStationCarrierCalls,
    maxDirectCarrierCalls,
    pendingHeartbeatSafe,
    requestCountSummary:
      `${selectedOrders} selected orders -> ${maxConcurrentBackfillOrders} active orders, ` +
      `${maxShipStationCarrierCalls} ShipStation carrier calls, ` +
      `${maxDirectCarrierCalls} direct-carrier calls max`,
  };
}
