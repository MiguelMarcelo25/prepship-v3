import type { CreateClientInput, UpdateClientInput } from "../../../../../../packages/contracts/src/clients/contracts.js";
import type { ClientRecord } from "../domain/client.js";
import type { InitStoreDto } from "../../../../../../packages/contracts/src/init/contracts.js";

export interface ClientRepository {
  listActive(): Promise<ClientRecord[]>;
  create(input: CreateClientInput): Promise<number>;
  update(clientId: number, input: UpdateClientInput): Promise<void>;
  softDelete(clientId: number): Promise<void>;
  syncFromStores(stores: InitStoreDto[]): Promise<void>;
}
