import type { SettingsServices } from "../application/settings-services.js";
import type { RateServices } from "../../rates/application/rate-services.js";

export class SettingsHttpHandler {
  private readonly services: SettingsServices;
  private readonly rateServices: RateServices;

  constructor(services: SettingsServices, rateServices: RateServices) {
    this.services = services;
    this.rateServices = rateServices;
  }

  async handleGet(key: string) {
    return await this.services.get(key);
  }

  async handlePut(key: string, body: unknown) {
    return await this.services.set(key, body);
  }

  async handleClearAndRefetch() {
    return await this.rateServices.clearAndRefetch();
  }
}
