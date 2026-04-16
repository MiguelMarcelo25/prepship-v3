import type { InitServices } from "../application/init-services.js";

export class InitHttpHandler {
  private readonly services: InitServices;

  constructor(services: InitServices) {
    this.services = services;
  }

  async handleInitData() {
    return await this.services.getInitData();
  }

  async handleCounts() {
    return await this.services.getCounts();
  }

  async handleStores() {
    return await this.services.getStores();
  }

  async handleCarriers() {
    return await this.services.getCarriers();
  }

  handleCarrierAccounts() {
    return this.services.getCarrierAccounts();
  }

  async handleRefreshCarriers() {
    return await this.services.refreshCarriers();
  }
}
