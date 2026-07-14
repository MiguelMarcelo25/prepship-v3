export type ShipStationEstimateRateIdentity = {
  carrier_id?: string | null;
};

export type ShipStationEstimateBatchPartition<T extends ShipStationEstimateRateIdentity> = {
  ratesByCarrierId: Map<string, T[]>;
  missingCarrierIds: string[];
  rejectedRates: T[];
};

/**
 * Attribute a multi-account estimate response only when ShipStation returned a
 * requested carrier_id. Missing accounts remain unresolved so rates.ts can use
 * its existing single-account retry path before declaring the set complete.
 */
export function partitionShipStationEstimateBatch<T extends ShipStationEstimateRateIdentity>(
  requestedCarrierIds: readonly string[],
  rates: readonly T[],
): ShipStationEstimateBatchPartition<T> {
  const orderedCarrierIds = [...new Set(requestedCarrierIds.map((id) => id.trim()).filter(Boolean))];
  const ratesByCarrierId = new Map(orderedCarrierIds.map((id) => [id, [] as T[]]));
  const rejectedRates: T[] = [];

  for (const rate of rates) {
    const carrierId = String(rate.carrier_id ?? '').trim();
    const carrierRates = ratesByCarrierId.get(carrierId);
    if (!carrierRates) {
      rejectedRates.push(rate);
      continue;
    }
    carrierRates.push(rate);
  }

  return {
    ratesByCarrierId,
    missingCarrierIds: orderedCarrierIds.filter((id) => ratesByCarrierId.get(id)?.length === 0),
    rejectedRates,
  };
}
