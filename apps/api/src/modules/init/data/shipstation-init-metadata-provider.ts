import type { TransitionalSecrets } from "../../../../../../../packages/shared/src/config/secrets-adapter.js";
import type { CarrierAccountDto, InitStoreDto } from "../../../../../../../packages/contracts/src/init/contracts.js";
import type { InitMetadataProvider } from "../application/init-metadata-provider.js";
import { getShipStationClient } from "../../../common/shipstation/client.js";

interface CacheEntry<T> {
  data: T | null;
  fetchedAt: number;
  ttlMs: number;
}

export class ShipstationInitMetadataProvider implements InitMetadataProvider {
  private readonly storesCache: CacheEntry<InitStoreDto[]>;
  private readonly carriersCache: CacheEntry<unknown[]>;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly carrierAccounts: CarrierAccountDto[];

  constructor(secrets: TransitionalSecrets, carrierAccounts: CarrierAccountDto[]) {
    const apiKey = secrets.shipstation?.api_key;
    const apiSecret = secrets.shipstation?.api_secret;
    if (!apiKey || !apiSecret) {
      throw new Error("Transitional ShipStation v1 credentials are required for init metadata");
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.carrierAccounts = carrierAccounts;
    this.storesCache = { data: null, fetchedAt: 0, ttlMs: 15 * 60 * 1000 };
    this.carriersCache = { data: null, fetchedAt: 0, ttlMs: 24 * 60 * 60 * 1000 };
  }

  async listStores(): Promise<InitStoreDto[]> {
    return this.getCached<InitStoreDto[]>("/stores", this.storesCache);
  }

  async listCarriers(): Promise<unknown[]> {
    return this.getCached<unknown[]>("/carriers", this.carriersCache);
  }

  listCarrierAccounts(): CarrierAccountDto[] {
    return [...this.carrierAccounts];
  }

  async refreshCarriers(): Promise<unknown[]> {
    this.carriersCache.data = null;
    this.carriersCache.fetchedAt = 0;
    return this.listCarriers();
  }

  private async getCached<T>(path: string, cache: CacheEntry<T>): Promise<T> {
    if (cache.data && (Date.now() - cache.fetchedAt) < cache.ttlMs) {
      return cache.data;
    }

    const client = getShipStationClient();
    try {
      const data = await client.v1<T>(
        { apiKey: this.apiKey, apiSecret: this.apiSecret },
        path,
        { deduplicate: true },
      );
      cache.data = data;
      cache.fetchedAt = Date.now();
      return data;
    } catch (error) {
      if (cache.data) return cache.data;
      throw error;
    }
  }
}
