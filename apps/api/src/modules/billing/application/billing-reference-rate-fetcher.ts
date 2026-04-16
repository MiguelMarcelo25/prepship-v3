import type { RateDimsDto } from "../../../../../../../packages/contracts/src/rates/contracts.js";

export interface FetchBillingReferenceRateGroupInput {
  orderIds: number[];
  weightOz: number;
  zip5: string;
  dims: RateDimsDto;
}

export interface BillingReferenceRateFetcher {
  fetchAndSaveReferenceRates(input: FetchBillingReferenceRateGroupInput): Promise<void>;
}
