import type {
  InitCountsDto,
  InitStoreDto,
} from "../../../../../../../packages/contracts/src/init/contracts.ts";

export interface InitRepository {
  listLocalClientStores(): Promise<InitStoreDto[]>;
  getCounts(): Promise<InitCountsDto>;
  getRateBrowserMarkups(): Promise<Record<string, unknown>>;
}
