import type { ShipmentServices } from "../application/shipment-services.js";

export class ShipmentsHttpHandler {
  private readonly services: ShipmentServices;

  constructor(services: ShipmentServices) {
    this.services = services;
  }

  handleSync() {
    return this.services.triggerSync();
  }

  async handleStatus() {
    return await this.services.getStatus();
  }

  handleLegacySyncTrigger(full: boolean) {
    return this.services.triggerLegacySync(full);
  }

  async handleLegacySyncStatus() {
    return await this.services.getLegacyStatus();
  }

  handleList(url: URL) {
    return this.services.list(url.searchParams);
  }
}
