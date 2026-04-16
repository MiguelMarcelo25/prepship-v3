import type { CreateClientInput, UpdateClientInput } from "../../../../../../packages/contracts/src/clients/contracts.ts";
import type { ClientRecord } from "../domain/client.ts";
import type { InitStoreDto } from "../../../../../../packages/contracts/src/init/contracts.ts";

export interface ClientRepository {
  listActive(): Promise<ClientRecord[]>;
  create(input: CreateClientInput): Promise<number>;
  update(clientId: number, input: UpdateClientInput): Promise<void>;
  softDelete(clientId: number): Promise<void>;
  syncFromStores(stores: InitStoreDto[]): Promise<void>;
}
