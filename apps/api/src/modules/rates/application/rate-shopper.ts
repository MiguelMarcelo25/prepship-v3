import type { RateDimsDto, RateDto } from "../../../../../../../packages/contracts/src/rates/contracts.js";

export interface LiveRateShopRequest {
  weightOz: number;
  toZip: string;
  dims: RateDimsDto | null;
  residential: boolean;
  sourceClientId: number | null;
  apiKeyV2: string | null;
  signature?: string;
}

export interface RateShopper {
  fetchRates(request: LiveRateShopRequest): Promise<RateDto[]>;
}
