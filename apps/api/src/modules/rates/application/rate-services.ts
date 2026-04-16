import type {
  BrowseRatesRequestDto,
  BulkCachedRatesRequestItem,
  BulkCachedRatesResponseDto,
  CachedRatesResponseDto,
  GetCachedRatesQuery,
  LiveRatesRequestDto,
  RateDimsDto,
  RateDto,
} from "../../../../../../../packages/contracts/src/rates/contracts.js";
import type { RateRepository, RefetchRateOrderRecord } from "./rate-repository.js";
import type { RateShopper } from "./rate-shopper.js";

const CACHE_VERSION = "v9";

function normalizeRateResponse(rates: RateDto[]): RateDto[] {
  return (rates || []).map((rate) => ({
    serviceCode: rate.serviceCode,
    serviceName: rate.serviceName,
    packageType: rate.packageType ?? null,
    shipmentCost: Number(rate.shipmentCost ?? 0),
    otherCost: Number(rate.otherCost ?? 0),
    rateDetails: Array.isArray(rate.rateDetails) ? rate.rateDetails : [],
    carrierCode: rate.carrierCode,
    shippingProviderId: rate.shippingProviderId ?? null,
    carrierNickname: rate.carrierNickname ?? null,
    guaranteed: Boolean(rate.guaranteed),
    zone: rate.zone == null ? null : String(rate.zone),
    sourceClientId: rate.sourceClientId ?? null,
    deliveryDays: rate.deliveryDays ?? null,
    estimatedDelivery: rate.estimatedDelivery ?? null,
  })).sort((left, right) =>
    (Number(left.shipmentCost ?? 0) + Number(left.otherCost ?? 0)) -
    (Number(right.shipmentCost ?? 0) + Number(right.otherCost ?? 0))
  );
}

function makeCacheKey(
  weight: number,
  zip: string,
  dims: RateDimsDto | null,
  residential: boolean,
  clientId: number | null,
  signature = "none",
): string {
  const dimPart = dims && dims.length > 0 && dims.width > 0 && dims.height > 0
    ? `|${dims.length}x${dims.width}x${dims.height}`
    : "";
  const clientPart = clientId !== null ? `|CL${clientId}` : "";
  const sigPart = signature !== "none" ? `|SIG${signature}` : "";
  return `${CACHE_VERSION}|${weight}|${zip}${dimPart}${residential ? "|R" : "|C"}${clientPart}${sigPart}`;
}

export class RateServices {
  private readonly repository: RateRepository;
  private readonly shopper: RateShopper;

  constructor(repository: RateRepository, shopper: RateShopper) {
    this.repository = repository;
    this.shopper = shopper;
  }

  async getCached(query: GetCachedRatesQuery): Promise<CachedRatesResponseDto> {
    const zip = query.zip.replace(/\D/g, "").slice(0, 5);
    if (!query.wt || !zip || zip.length < 5) {
      return { cached: false, rates: [], best: null };
    }

    const clientId = query.storeId ? await this.repository.getClientIdForStoreId(query.storeId) : null;
    const signature = query.signature && query.signature.trim() ? query.signature : "none";
    const cacheKey = makeCacheKey(query.wt, zip, query.dims, query.residential, clientId, signature);
    const cached = await this.readValidCache(cacheKey);
    if (!cached) {
      return { cached: false, rates: [], best: null };
    }

    return {
      cached: true,
      rates: normalizeRateResponse(cached.rates),
      best: cached.bestRate,
      fetchedAt: Date.now(),
    };
  }

  async getCachedBulk(items: BulkCachedRatesRequestItem[]): Promise<BulkCachedRatesResponseDto> {
    const results: BulkCachedRatesResponseDto["results"] = {};
    const missing: string[] = [];

    for (const item of items) {
      const zip = String(item.zip ?? "").replace(/\D/g, "").slice(0, 5);
      const residential = item.residential !== false;
      const storeId = item.storeId != null ? Number(item.storeId) : null;
      const clientId = storeId ? await this.repository.getClientIdForStoreId(storeId) : null;
      const signature = item.signature && item.signature.trim() ? item.signature : "none";
      const cacheKey = makeCacheKey(item.wt, zip, item.dims ?? null, residential, clientId, signature);
      const cached = await this.readValidCache(cacheKey);

      if (!cached) {
        results[item.key] = { cached: false, best: null };
        missing.push(item.key);
        continue;
      }

      results[item.key] = {
        cached: true,
        rates: normalizeRateResponse(cached.rates),
        fetchedAt: Date.now(),
      };
    }

    return { results, missing };
  }

  async listCarriersForStore(storeId: number | null) {
    const clientId = storeId ? await this.repository.getClientIdForStoreId(storeId) : null;
    return await this.repository.listCarriersForClient(clientId);
  }

  async getLiveRates(input: LiveRatesRequestDto): Promise<RateDto[]> {
    const weightOz = Math.round(Number(input.weight?.value ?? 16));
    const zip = String(input.toPostalCode ?? "").replace(/\D/g, "").slice(0, 5);
    const dims = this.normalizeDims(input.dimensions ?? null);
    const residential = input.residential !== false;
    const storeId = input.storeId != null ? Number(input.storeId) : null;
    const clientId = storeId ? await this.repository.getClientIdForStoreId(storeId) : null;

    if (!zip || zip.length < 5) {
      return [];
    }

    const cacheKey = makeCacheKey(weightOz, zip, dims, residential, clientId);
    const cached = await this.readValidCache(cacheKey);
    if (cached) {
      if (input.orderIds?.length) {
        await this.repository.saveReferenceRates(input.orderIds, cached.rates, weightOz, dims, storeId);
      } else if (input.orderId != null) {
        await this.repository.saveReferenceRates([input.orderId], cached.rates, weightOz, dims, storeId);
      }
      return normalizeRateResponse(cached.rates);
    }

    const source = await this.repository.getRateSourceConfig(clientId);
    const rates = normalizeRateResponse(await this.shopper.fetchRates({
      weightOz,
      toZip: zip,
      dims,
      residential,
      sourceClientId: source.sourceClientId,
      apiKeyV2: source.apiKeyV2,
    }));

    if (rates.length > 0) {
      const best = rates[0] ?? null;
      await this.repository.saveCachedRate(cacheKey, weightOz, zip, rates, best, await this.repository.getCurrentWeightVersion());
      if (input.orderIds?.length) {
        await this.repository.saveReferenceRates(input.orderIds, rates, weightOz, dims, storeId);
      } else if (input.orderId != null) {
        await this.repository.saveReferenceRates([input.orderId], rates, weightOz, dims, storeId);
      }
    }

    return rates;
  }

  async browseRates(input: BrowseRatesRequestDto): Promise<{ rates: RateDto[] }> {
    if (!input.shippingProviderId) {
      throw new Error("shippingProviderId required");
    }

    const weightOz = Math.round(Number(input.weightOz ?? 16));
    const zip = String(input.toPostalCode ?? "").replace(/\D/g, "").slice(0, 5);
    const dims = this.normalizeDims(input.dimensions ?? null);
    const residential = input.residential !== false;
    const storeId = input.storeId != null ? Number(input.storeId) : null;
    const clientId = storeId ? await this.repository.getClientIdForStoreId(storeId) : null;
    const signature = input.signatureOption && input.signatureOption.trim() ? input.signatureOption : "none";

    const cacheKey = makeCacheKey(weightOz, zip, dims, residential, clientId, signature);
    const cached = await this.readValidCache(cacheKey);
    let allRates: RateDto[];
    if (cached) {
      allRates = cached.rates;
    } else {
      const source = await this.repository.getRateSourceConfig(clientId);
      allRates = normalizeRateResponse(await this.shopper.fetchRates({
        weightOz,
        toZip: zip,
        dims,
        residential,
        sourceClientId: source.sourceClientId,
        apiKeyV2: source.apiKeyV2,
        signature,
      }));
    }

    if (!cached && allRates.length > 0) {
      await this.repository.saveCachedRate(cacheKey, weightOz, zip, allRates, allRates[0] ?? null, await this.repository.getCurrentWeightVersion());
    }

    return {
      rates: allRates.filter((rate) => rate.shippingProviderId === input.shippingProviderId),
    };
  }

  async clearAndRefetch(): Promise<{ ok: true; message: string; ordersQueued: number }> {
    await this.repository.clearCaches();
    const orders = await this.repository.listOrdersForRateRefetch(1000);

    for (const order of orders) {
      void this.prefetchOrderRates(order);
    }

    return {
      ok: true,
      message: "Cache cleared successfully",
      ordersQueued: orders.length,
    };
  }

  private normalizeDims(dimensions: LiveRatesRequestDto["dimensions"] | BrowseRatesRequestDto["dimensions"]): RateDimsDto | null {
    const length = Number(dimensions?.length ?? 0);
    const width = Number(dimensions?.width ?? 0);
    const height = Number(dimensions?.height ?? 0);
    if (length <= 0 || width <= 0 || height <= 0) {
      return null;
    }
    return { length, width, height };
  }

  private async readValidCache(cacheKey: string): Promise<{ rates: RateDto[]; bestRate: RateDto | null } | null> {
    const cached = await this.repository.getCachedRate(cacheKey);
    if (!cached) return null;

    const currentWeightVersion = await this.repository.getCurrentWeightVersion();
    if ((cached.weightVersion ?? 0) !== currentWeightVersion) {
      return null;
    }

    try {
      const rates = JSON.parse(cached.ratesJson) as RateDto[];
      const bestRate = cached.bestRateJson ? JSON.parse(cached.bestRateJson) as RateDto : null;
      return {
        rates,
        bestRate: bestRate ? normalizeRateResponse([bestRate])[0] ?? null : null,
      };
    } catch {
      return null;
    }
  }

  private async prefetchOrderRates(order: RefetchRateOrderRecord): Promise<void> {
    if (!order.shipToPostalCode || !order.weightOz || order.weightOz <= 0) {
      return;
    }

    await this.getLiveRates({
      orderId: order.orderId,
      toPostalCode: order.shipToPostalCode,
      weight: { value: order.weightOz, units: "ounces" },
      dimensions: order.dims,
      residential: order.residential,
      storeId: order.storeId,
    });
  }
}
