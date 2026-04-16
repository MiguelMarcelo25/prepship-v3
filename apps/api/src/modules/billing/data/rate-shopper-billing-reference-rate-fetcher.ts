import type { RateDimsDto } from "../../../../../../../packages/contracts/src/rates/contracts.js";
import type { BillingReferenceRateFetcher, FetchBillingReferenceRateGroupInput } from "../application/billing-reference-rate-fetcher.js";
import type { RateShopper } from "../../rates/application/rate-shopper.js";
import type { RateRepository } from "../../rates/application/rate-repository.js";

export class RateShopperBillingReferenceRateFetcher implements BillingReferenceRateFetcher {
  private readonly rateRepository: RateRepository;
  private readonly rateShopper: RateShopper;

  constructor(rateRepository: RateRepository, rateShopper: RateShopper) {
    this.rateRepository = rateRepository;
    this.rateShopper = rateShopper;
  }

  async fetchAndSaveReferenceRates(input: FetchBillingReferenceRateGroupInput): Promise<void> {
    const source = this.rateRepository.getRateSourceConfig(null);
    const dims = this.normalizeDims(input.dims);
    const rates = await this.rateShopper.fetchRates({
      weightOz: input.weightOz,
      toZip: input.zip5,
      dims,
      residential: true,
      sourceClientId: source.sourceClientId,
      apiKeyV2: source.apiKeyV2,
    });

    if (rates.length === 0) {
      throw new Error("No live rates returned");
    }

    this.rateRepository.saveReferenceRates(input.orderIds, rates, input.weightOz, dims, null);
  }

  private normalizeDims(dims: RateDimsDto): RateDimsDto {
    return {
      length: Number(dims.length),
      width: Number(dims.width),
      height: Number(dims.height),
    };
  }
}
