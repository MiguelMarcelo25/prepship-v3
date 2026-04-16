import type { CreateClientInput, UpdateClientInput } from "../../../../../../packages/contracts/src/clients/contracts.js";
import type { ClientServices } from "../application/client-services.js";

export class ClientsHttpHandler {
  private readonly services: ClientServices;

  constructor(services: ClientServices) {
    this.services = services;
  }

  async handleList() {
    return await this.services.list();
  }

  async handleCreate(body: CreateClientInput) {
    return await this.services.create(body);
  }

  async handleUpdate(clientId: number, body: UpdateClientInput) {
    return await this.services.update(clientId, body);
  }

  async handleDelete(clientId: number) {
    return await this.services.remove(clientId);
  }

  async handleSyncStores() {
    return await this.services.syncStores();
  }
}
