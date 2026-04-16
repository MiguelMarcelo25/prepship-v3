import type {
  BackfillBillingReferenceRatesInput,
  BackfillBillingReferenceRatesResult,
  BillingConfigDto,
  BillingDetailsQuery,
  BillingReferenceRateFetchStatusDto,
  BillingPackagePriceDto,
  BillingSummaryDto,
  BillingSummaryQuery,
  FetchBillingReferenceRatesResult,
  GenerateBillingInput,
  GenerateBillingResult,
  SaveBillingPackagePricesInput,
  SetDefaultBillingPackagePriceInput,
  SetDefaultBillingPackagePriceResult,
  UpdateBillingConfigInput,
} from "../../../../../../../packages/contracts/src/billing/contracts.js";
import type { BillingRepository } from "./billing-repository.js";
import type { BillingReferenceRateFetcher } from "./billing-reference-rate-fetcher.js";
import { isBlockedRate } from "../../../common/prepship-config.js";

const DEFAULT_BILLING_CONFIG = {
  pickPackFee: 3,
  additionalUnitFee: 0.75,
  packageCostMarkup: 0,
  shippingMarkupPct: 0,
  shippingMarkupFlat: 0,
  billing_mode: "label_cost",
  storageFeePerCuFt: 0,
  storageFeeMode: "cubicft",
  palletPricingPerMonth: 0,
  palletCuFt: 80,
} as const;

function isIsoDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

export class BillingServices {
  private readonly repository: BillingRepository;
  private readonly referenceRateFetcher: BillingReferenceRateFetcher;
  private refRateFetchStatus: BillingReferenceRateFetchStatusDto = {
    running: false,
    total: 0,
    done: 0,
    errors: 0,
    startedAt: null,
  };

  constructor(repository: BillingRepository, referenceRateFetcher: BillingReferenceRateFetcher) {
    this.repository = repository;
    this.referenceRateFetcher = referenceRateFetcher;
  }

  async getConfig(): Promise<BillingConfigDto[]> {
    const configs = new Map((await this.repository.listConfigRecords()).map((record) => [record.clientId, record]));

    return (await this.repository.listBillableClients()).map((client) => {
      const config = configs.get(client.clientId);
      return {
        clientId: client.clientId,
        clientName: client.name,
        pickPackFee: config?.pickPackFee ?? DEFAULT_BILLING_CONFIG.pickPackFee,
        additionalUnitFee: config?.additionalUnitFee ?? DEFAULT_BILLING_CONFIG.additionalUnitFee,
        packageCostMarkup: config?.packageCostMarkup ?? DEFAULT_BILLING_CONFIG.packageCostMarkup,
        shippingMarkupPct: config?.shippingMarkupPct ?? DEFAULT_BILLING_CONFIG.shippingMarkupPct,
        shippingMarkupFlat: config?.shippingMarkupFlat ?? DEFAULT_BILLING_CONFIG.shippingMarkupFlat,
        billing_mode: config?.billing_mode ?? DEFAULT_BILLING_CONFIG.billing_mode,
        storageFeePerCuFt: config?.storageFeePerCuFt ?? DEFAULT_BILLING_CONFIG.storageFeePerCuFt,
        storageFeeMode: config?.storageFeeMode ?? DEFAULT_BILLING_CONFIG.storageFeeMode,
        palletPricingPerMonth: config?.palletPricingPerMonth ?? DEFAULT_BILLING_CONFIG.palletPricingPerMonth,
        palletCuFt: config?.palletCuFt ?? DEFAULT_BILLING_CONFIG.palletCuFt,
      };
    });
  }

  async getSummary(query: BillingSummaryQuery): Promise<BillingSummaryDto[]> {
    if (!query.from || !query.to) {
      throw new Error("from and to required");
    }
    if (!isIsoDateOnly(query.from) || !isIsoDateOnly(query.to)) {
      throw new Error("from and to must be YYYY-MM-DD");
    }
    return await this.repository.listSummary(query);
  }

  async getDetails(query: BillingDetailsQuery) {
    if (!query.from || !query.to || !query.clientId) {
      throw new Error("from, to, clientId required");
    }
    if (!isIsoDateOnly(query.from) || !isIsoDateOnly(query.to)) {
      throw new Error("from and to must be YYYY-MM-DD");
    }
    return await this.repository.listDetails({
      from: query.from,
      to: query.to,
      clientId: query.clientId,
    });
  }

  async getPackagePrices(clientId?: number): Promise<BillingPackagePriceDto[]> {
    if (!clientId) {
      throw new Error("clientId required");
    }
    return await this.repository.listPackagePrices(clientId);
  }

  async getInvoice(clientId: number, from: string, to: string) {
    if (!clientId || !from || !to) {
      throw new Error("from, to, clientId required");
    }
    if (!isIsoDateOnly(from) || !isIsoDateOnly(to)) {
      throw new Error("from and to must be YYYY-MM-DD");
    }
    return await this.repository.getInvoice(clientId, from, to);
  }

  getRefRateFetchStatus(): BillingReferenceRateFetchStatusDto {
    return { ...this.refRateFetchStatus };
  }

  async fetchReferenceRates(): Promise<FetchBillingReferenceRatesResult> {
    if (this.refRateFetchStatus.running) {
      return {
        ok: false,
        message: "Already running",
        status: this.getRefRateFetchStatus(),
      };
    }

    const storeIds = await this.repository.listReferenceRateStoreIds();
    if (storeIds.length === 0) {
      return { ok: false, message: "No reference_rate clients configured" };
    }

    const orders = await this.repository.listOrdersMissingReferenceRatesForFetch(storeIds);
    if (orders.length === 0) {
      return { ok: true, message: "All orders already have ref rates", total: 0 };
    }

    const groups = new Map<string, { orderIds: number[]; weightOz: number; zip5: string; dims: { length: number; width: number; height: number } }>();
    for (const order of orders) {
      const zip5 = String(order.zip5 ?? "").replace(/\D/g, "").slice(0, 5);
      const weightOz = Math.round(Number(order.weightOz ?? 0));
      const length = Number(order.dims_l ?? 0);
      const width = Number(order.dims_w ?? 0);
      const height = Number(order.dims_h ?? 0);
      if (!zip5 || zip5.length !== 5 || weightOz <= 0 || length <= 0 || width <= 0 || height <= 0) {
        continue;
      }
      const key = `${weightOz}|${zip5}|${length}x${width}x${height}`;
      if (!groups.has(key)) {
        groups.set(key, {
          orderIds: [],
          weightOz,
          zip5,
          dims: { length, width, height },
        });
      }
      groups.get(key)?.orderIds.push(order.orderId);
    }

    if (groups.size === 0) {
      return { ok: true, message: "All orders already have ref rates", total: 0 };
    }

    this.refRateFetchStatus = {
      running: true,
      total: groups.size,
      done: 0,
      errors: 0,
      startedAt: Date.now(),
    };

    void this.runReferenceRateFetch([...groups.values()]);

    return {
      ok: true,
      queued: groups.size,
      orders: orders.length,
      message: `Queuing ${groups.size} rate fetches for ${orders.length} orders — running in background`,
    };
  }

  async backfillReferenceRates(input: BackfillBillingReferenceRatesInput): Promise<BackfillBillingReferenceRatesResult> {
    const orders = await this.repository.listOrdersMissingReferenceRatesForBackfill(input);
    if (orders.length === 0) {
      const storeIds = await this.repository.listReferenceRateStoreIds();
      if (storeIds.length === 0) {
        return { ok: true, filled: 0, missing: 0, message: "No reference_rate clients configured" };
      }
      return { ok: true, filled: 0, missing: 0, message: "All orders already have reference rates" };
    }

    let filled = 0;
    let missing = 0;

    for (const order of orders) {
      const weightOz = Math.round(Number(order.weightOz ?? 1));
      const zip5 = String(order.zip5 ?? "").replace(/\D/g, "").slice(0, 5);
      if (!zip5 || zip5.length !== 5) {
        missing += 1;
        continue;
      }

      const rates = await this.repository.findCachedReferenceRateCandidates(weightOz, zip5);
      if (!rates || rates.length === 0) {
        missing += 1;
        continue;
      }

      const refUsps = this.pickReferenceRate(rates, 433542);
      const refUps = this.pickReferenceRate(rates, 433543);
      if (refUsps == null && refUps == null) {
        missing += 1;
        continue;
      }

      await this.repository.saveBackfilledReferenceRates(order.orderId, refUsps, refUps);
      filled += 1;
    }

    return { ok: true, filled, missing, total: orders.length };
  }

  async updateConfig(clientId: number, input: UpdateBillingConfigInput) {
    await this.repository.upsertConfig(clientId, input);
    return { ok: true };
  }

  async generate(input: GenerateBillingInput): Promise<GenerateBillingResult> {
    if (!input.from || !input.to) {
      throw new Error("from and to required");
    }
    if (!isIsoDateOnly(input.from) || !isIsoDateOnly(input.to)) {
      throw new Error("from and to must be YYYY-MM-DD");
    }
    return await this.repository.generate(input);
  }

  async savePackagePrices(input: SaveBillingPackagePricesInput) {
    if (!input.clientId || !Array.isArray(input.prices)) {
      throw new Error("clientId and prices[] required");
    }
    await this.repository.savePackagePrices({
      clientId: input.clientId,
      prices: input.prices,
    });
    return { ok: true };
  }

  async setDefaultPackagePrice(input: SetDefaultBillingPackagePriceInput): Promise<SetDefaultBillingPackagePriceResult> {
    if (!input.packageId || input.price == null) {
      throw new Error("packageId and price required");
    }
    return await this.repository.setDefaultPackagePrice(input.packageId, input.price);
  }

  private pickReferenceRate(rates: Array<{ shippingProviderId?: number | null; shipmentCost?: number; otherCost?: number; serviceCode?: string; packageType?: string | null; serviceName?: string }>, shippingProviderId: number): number | null {
    const costs = rates
      .filter((rate) => rate.shippingProviderId === shippingProviderId && !isBlockedRate(rate, null))
      .map((rate) => Number(rate.shipmentCost ?? 0) + Number(rate.otherCost ?? 0));

    return costs.length > 0 ? Math.min(...costs) : null;
  }

  private async runReferenceRateFetch(groups: Array<{ orderIds: number[]; weightOz: number; zip5: string; dims: { length: number; width: number; height: number } }>): Promise<void> {
    try {
      for (const group of groups) {
        try {
          await this.referenceRateFetcher.fetchAndSaveReferenceRates(group);
        } catch {
          this.refRateFetchStatus.errors += 1;
        }
        this.refRateFetchStatus.done += 1;
      }
    } finally {
      this.refRateFetchStatus.running = false;
    }
  }
}
