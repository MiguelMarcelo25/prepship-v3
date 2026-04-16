import {
  parseBillingDetailsQuery,
  parseBillingPackagePricesQuery,
  parseBillingSummaryQuery,
} from "../../../../../../packages/contracts/src/billing/contracts.js";
import { InputValidationError, parseOptionalIntegerParam } from "../../../../../../packages/contracts/src/common/input-validation.js";
import type { BillingServices } from "../application/billing-services.js";

export class BillingHttpHandler {
  private readonly services: BillingServices;

  constructor(services: BillingServices) {
    this.services = services;
  }

  async handleConfig() {
    return await this.services.getConfig();
  }

  async handleSummary(url: URL) {
    return await this.services.getSummary(parseBillingSummaryQuery(url));
  }

  async handleDetails(url: URL) {
    return await this.services.getDetails(parseBillingDetailsQuery(url));
  }

  async handlePackagePrices(url: URL) {
    return await this.services.getPackagePrices(parseBillingPackagePricesQuery(url).clientId);
  }

  async handleUpdateConfig(clientId: number, body: unknown) {
    return await this.services.updateConfig(clientId, body as Record<string, unknown>);
  }

  async handleGenerate(body: unknown) {
    return await this.services.generate(body as Record<string, unknown>);
  }

  async handleUpdatePackagePrices(body: unknown) {
    return await this.services.savePackagePrices(body as Record<string, unknown>);
  }

  async handleSetDefaultPackagePrices(body: unknown) {
    return await this.services.setDefaultPackagePrice(body as Record<string, unknown>);
  }

  async handleInvoice(url: URL) {
    const clientId = parseOptionalIntegerParam(url.searchParams.get("clientId"), "clientId");
    if (clientId == null) {
      throw new InputValidationError("clientId required");
    }
    return await this.services.getInvoice(clientId, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "");
  }

  async handleFetchRefRates() {
    return await this.services.fetchReferenceRates();
  }

  handleFetchRefRatesStatus() {
    return this.services.getRefRateFetchStatus();
  }

  async handleBackfillRefRates(body: unknown) {
    return await this.services.backfillReferenceRates(body as Record<string, unknown>);
  }
}
