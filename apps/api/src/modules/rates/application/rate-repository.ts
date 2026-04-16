import type { CarrierAccountDto } from "../../../../../../../packages/contracts/src/init/contracts.ts";
import type { RateDimsDto, RateDto } from "../../../../../../../packages/contracts/src/rates/contracts.ts";

export interface CachedRateRecord {
  ratesJson: string;
  bestRateJson: string | null;
  weightVersion: number | null;
}

export interface RateSourceConfig {
  apiKeyV2: string | null;
  sourceClientId: number | null;
}

export interface RefetchRateOrderRecord {
  orderId: number;
  storeId: number | null;
  shipToPostalCode: string | null;
  weightOz: number | null;
  residential: boolean;
  dims: RateDimsDto | null;
}

export interface RateRepository {
  getClientIdForStoreId(storeId: number): Promise<number | null>;
  getCurrentWeightVersion(): Promise<number>;
  getCachedRate(cacheKey: string): Promise<CachedRateRecord | null>;
  listCarriersForClient(clientId: number | null): Promise<CarrierAccountDto[]>;
  getRateSourceConfig(clientId: number | null): Promise<RateSourceConfig>;
  clearCaches(): Promise<void>;
  listOrdersForRateRefetch(limit: number): Promise<RefetchRateOrderRecord[]>;
  saveCachedRate(
    cacheKey: string,
    weightOz: number,
    toZip: string,
    rates: RateDto[],
    bestRate: RateDto | null,
    weightVersion: number,
  ): Promise<void>;
  saveReferenceRates(orderIds: number[], rates: RateDto[], weightOz: number, dims: RateDimsDto | null, storeId: number | null): Promise<void>;
}
