import type {
  InitCountsDto,
  InitDataDto,
  InitStoreDto,
} from "../../../../../../../packages/contracts/src/init/contracts.ts";
import type { InitMetadataProvider } from "./init-metadata-provider.ts";
import type { InitRepository } from "./init-repository.ts";
import type { ClientServices } from "../../../modules/clients/application/client-services.ts";

export class InitServices {
  private readonly repository: InitRepository;
  private readonly metadataProvider: InitMetadataProvider;
  private readonly clientServices: ClientServices;
  private readonly excludedStoreIds: number[];

  constructor(
    repository: InitRepository,
    metadataProvider: InitMetadataProvider,
    clientServices: ClientServices,
    excludedStoreIds: number[]
  ) {
    this.repository = repository;
    this.metadataProvider = metadataProvider;
    this.clientServices = clientServices;
    this.excludedStoreIds = excludedStoreIds;
  }

  async getInitData(): Promise<InitDataDto> {
    let remoteStores: InitStoreDto[] = [];
    try {
      remoteStores = await this.metadataProvider.listStores();
    } catch (err) {
      console.warn(`Failed to fetch remote stores from ShipStation, using local stores only:`, err);
      // Continue with empty remoteStores - mergeStores will use local stores as fallback
    }

    return {
      stores: await this.mergeStores(remoteStores),
      carriers: this.metadataProvider.listCarrierAccounts(),
      counts: await this.repository.getCounts(),
      markups: await this.repository.getRateBrowserMarkups(),
      clients: await this.clientServices.list(),
    };
  }

  async getCounts(): Promise<InitCountsDto> {
    return await this.repository.getCounts();
  }

  async getStores(): Promise<InitStoreDto[]> {
    const remoteStores = await this.metadataProvider.listStores();
    return await this.mergeStores(remoteStores);
  }

  async getCarriers(): Promise<unknown[]> {
    return this.metadataProvider.listCarriers();
  }

  getCarrierAccounts() {
    return this.metadataProvider.listCarrierAccounts();
  }

  async refreshCarriers() {
    const carriers = await this.metadataProvider.refreshCarriers();
    return {
      success: true,
      message: "Carrier cache refreshed from ShipStation",
      carrierCount: carriers.length,
      timestamp: new Date().toISOString(),
    };
  }

  private async mergeStores(remoteStores: InitStoreDto[]): Promise<InitStoreDto[]> {
    const filteredRemoteStores = remoteStores.filter((store) => !this.excludedStoreIds.includes(store.storeId));
    const stores = [...filteredRemoteStores];

    for (const localStore of await this.repository.listLocalClientStores()) {
      if (this.excludedStoreIds.includes(localStore.storeId)) continue;
      if (stores.some((store) => store.storeId === localStore.storeId)) continue;
      stores.push(localStore);
    }

    return stores;
  }
}
