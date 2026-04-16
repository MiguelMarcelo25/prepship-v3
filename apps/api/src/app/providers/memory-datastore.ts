import type {
  BackfillBillingReferenceRatesInput,
  BillingDetailsQuery,
  GenerateBillingInput,
  GenerateBillingResult,
  SaveBillingPackagePriceInput,
  BillingSummaryQuery,
  SetDefaultBillingPackagePriceResult,
  UpdateBillingConfigInput,
} from "../../../../../../packages/contracts/src/billing/contracts.ts";
import type { CarrierAccountDto, InitCountsDto, InitStoreDto } from "../../../../../../packages/contracts/src/init/contracts.ts";
import type { AdjustInventoryInput, ListInventoryLedgerQuery, ListInventoryQuery, ReceiveInventoryInput, ReceiveInventoryResultDto, UpdateInventoryItemInput } from "../../../../../../packages/contracts/src/inventory/contracts.ts";
import type { BulkUpdateInventoryDimensionsInput, ParentSkuDetailDto, ParentSkuDto, SaveParentSkuInput, SetInventoryParentInput } from "../../../../../../packages/contracts/src/inventory/contracts.ts";
import type { ExistingLabelRecord, LabelOrderRecord, LabelShipmentRecord, PersistedShipmentInput, ResolvedPackageDimensions, ReturnLabelRecord, ShippingAccountContext } from "../../modules/labels/domain/label.ts";
import type { LabelRepository } from "../../modules/labels/application/label-repository.ts";
import type { SaveLocationInput } from "../../../../../../packages/contracts/src/locations/contracts.ts";
import type { GetOrderIdsQuery, GetOrderPicklistQuery, ListOrdersQuery, OrderBestRateDto, OrderExportQuery, OrderExportRow, OrderFullDto, OrderPicklistItemDto, OrdersDailyStatsDto } from "../../../../../../packages/contracts/src/orders/contracts.ts";
import type { AutoCreatePackageInput, PackageAdjustmentInput, SavePackageInput } from "../../../../../../packages/contracts/src/packages/contracts.ts";
import type { SaveProductDefaultsInput } from "../../../../../../packages/contracts/src/products/contracts.ts";
import type { RateDimsDto, RateDto } from "../../../../../../packages/contracts/src/rates/contracts.ts";
import type { ShipmentRepository } from "../../modules/shipments/application/shipment-repository.ts";
import type { ShipmentSyncAccountRecord, ShipmentSyncRecord } from "../../modules/shipments/domain/shipment.ts";
import { BLOCKED_CARRIER_IDS, CARRIER_ACCOUNTS_V2 } from "../../common/prepship-config.ts";
import type { ApiDataStore } from "../datastore.ts";
import type { AnalysisRepository } from "../../modules/analysis/application/analysis-repository.ts";
import type { AnalysisDailySalesRow, AnalysisOrderRow } from "../../modules/analysis/domain/analysis.ts";
import type { BillingRepository } from "../../modules/billing/application/billing-repository.ts";
import type {
  BillingBackfillReferenceRateOrderRecord,
  BillingClientRecord,
  BillingConfigRecord,
  BillingDetailRecord,
  BillingFetchReferenceRateOrderRecord,
  BillingPackagePriceRecord,
  BillingSummaryRecord,
} from "../../modules/billing/domain/billing.ts";
import type { BillingInvoiceRecord } from "../../modules/billing/domain/billing.ts";
import type { ClientRepository } from "../../modules/clients/application/client-repository.ts";
import type { ClientRecord } from "../../modules/clients/domain/client.ts";
import type { InitRepository } from "../../modules/init/application/init-repository.ts";
import type { InventoryRepository } from "../../modules/inventory/application/inventory-repository.ts";
import type { InventoryAlertRecord, InventoryRecord } from "../../modules/inventory/domain/inventory.ts";
import { InMemoryShipFromState, type ShipFromState } from "../../modules/locations/application/ship-from-state.ts";
import type { LocationRepository } from "../../modules/locations/application/location-repository.ts";
import type { LocationRecord } from "../../modules/locations/domain/location.ts";
import type { ManifestRepository } from "../../modules/manifests/application/manifest-repository.ts";
import type { ManifestShipmentRecord } from "../../modules/manifests/domain/manifest.ts";
import type { OrderListResult, OrderRepository } from "../../modules/orders/application/order-repository.ts";
import type { OrderRecord } from "../../modules/orders/domain/order.ts";
import type { PackageRepository } from "../../modules/packages/application/package-repository.ts";
import type { PackageRecord } from "../../modules/packages/domain/package.ts";
import type { ProductRepository } from "../../modules/products/application/product-repository.ts";
import type { ProductDefaultsRecord, SaveProductDefaultsRecordResult } from "../../modules/products/domain/product.ts";
import type { CachedRateRecord, RateRepository, RateSourceConfig, RefetchRateOrderRecord } from "../../modules/rates/application/rate-repository.ts";
import type { SettingsRepository } from "../../modules/settings/application/settings-repository.ts";
import type { QueueRepository } from "../../modules/queue/application/queue-repository.ts";
import type { AddToQueueInput, PrintQueueEntry } from "../../modules/queue/domain/queue.ts";
import { randomUUID } from "node:crypto";

interface MemoryOrderEntry {
  record: OrderRecord;
  items: Array<Record<string, unknown>>;
  full?: OrderFullDto | null;
  clientName?: string;
}

export interface MemoryDataStoreSeed {
  analysis?: {
    orderRows?: AnalysisOrderRow[];
    dailySalesRows?: AnalysisDailySalesRow[];
    storeClientNameMap?: Record<number, string>;
    inventorySkuMap?: Array<{ sku: string; invSkuId: number }>;
    clientStoreIds?: Record<number, number[]>;
  };
  billing?: {
    clients?: BillingClientRecord[];
    configs?: BillingConfigRecord[];
    summary?: BillingSummaryRecord[];
    details?: BillingDetailRecord[];
    packagePrices?: Record<number, BillingPackagePriceRecord[]>;
    referenceRateStoreIds?: number[];
    fetchOrders?: BillingFetchReferenceRateOrderRecord[];
    backfillOrders?: BillingBackfillReferenceRateOrderRecord[];
  };
  clients?: ClientRecord[];
  init?: {
    localStores?: InitStoreDto[];
    counts?: InitCountsDto;
    markups?: Record<string, unknown>;
  };
  inventory?: {
    records?: InventoryRecord[];
    ledger?: Array<Record<string, unknown>>;
    parents?: ParentSkuDto[];
    nextId?: number;
  };
  locations?: LocationRecord[];
  manifests?: {
    shipments?: ManifestShipmentRecord[];
  };
  labels?: {
    shipments?: LabelShipmentRecord[];
  };
  orders?: MemoryOrderEntry[];
  packages?: {
    records?: PackageRecord[];
    ledger?: Record<number, Array<Record<string, unknown>>>;
    nextId?: number;
  };
  products?: {
    bySku?: Record<string, ProductDefaultsRecord>;
  };
  rates?: {
    storeClientMap?: Record<number, number>;
    weightVersion?: number;
    cache?: Record<string, CachedRateRecord>;
    carriers?: CarrierAccountDto[];
    refetchOrders?: RefetchRateOrderRecord[];
  };
  settings?: Record<string, string>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseStoreIds(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => Number.parseInt(String(value), 10)).filter(Number.isFinite);
  } catch {
    return [];
  }
}

class MemoryAnalysisRepository implements AnalysisRepository {
  private readonly seed: MemoryDataStoreSeed["analysis"];

  constructor(seed: MemoryDataStoreSeed["analysis"]) {
    this.seed = seed;
  }

  async listOrderRows(query: { clientId?: number }): AnalysisOrderRow[] {
    const rows = clone(this.seed?.orderRows ?? []);
    if (!query.clientId) return rows;
    const allowed = new Set(await this.getClientStoreIds(query.clientId));
    return rows.filter((row) => row.storeId != null && allowed.has(row.storeId));
  }

  async listDailySalesRows(query: { clientId?: number }, since: string, until: string): AnalysisDailySalesRow[] {
    const rows = clone(this.seed?.dailySalesRows ?? []);
    void since;
    void until;
    if (!query.clientId) return rows;
    return rows;
  }

  async getStoreClientNameMap(): Record<number, string> {
    return { ...(this.seed?.storeClientNameMap ?? {}) };
  }

  async getInventorySkuMap(): Map<string, number> {
    return new Map((this.seed?.inventorySkuMap ?? []).map((entry) => [entry.sku, entry.invSkuId]));
  }

  async getClientStoreIds(clientId: number): number[] {
    return [...(this.seed?.clientStoreIds?.[clientId] ?? [])];
  }
}

class MemoryBillingRepository implements BillingRepository {
  private readonly clients: BillingClientRecord[];
  private readonly configs: BillingConfigRecord[];
  private readonly summary: BillingSummaryRecord[];
  private readonly details: BillingDetailRecord[];
  private readonly packagePrices: Record<number, BillingPackagePriceRecord[]>;
  private readonly referenceRateStoreIds: number[];
  private readonly fetchOrders: BillingFetchReferenceRateOrderRecord[];
  private readonly backfillOrders: BillingBackfillReferenceRateOrderRecord[];
  private readonly cachedReferenceRates: Record<string, RateDto[]>;
  private readonly backfilledReferenceRates = new Map<number, { refUspsRate: number | null; refUpsRate: number | null }>();

  constructor(seed: MemoryDataStoreSeed["billing"]) {
    this.clients = clone(seed?.clients ?? []);
    this.configs = clone(seed?.configs ?? []);
    this.summary = clone(seed?.summary ?? []);
    this.details = clone(seed?.details ?? []);
    this.packagePrices = clone(seed?.packagePrices ?? {});
    this.referenceRateStoreIds = clone(seed?.referenceRateStoreIds ?? []);
    this.fetchOrders = clone(seed?.fetchOrders ?? []);
    this.backfillOrders = clone(seed?.backfillOrders ?? []);
    this.cachedReferenceRates = {};
  }

  async listBillableClients(): BillingClientRecord[] {
    return clone(this.clients);
  }

  async listConfigRecords(): BillingConfigRecord[] {
    return clone(this.configs);
  }

  async listReferenceRateStoreIds(): number[] {
    return clone(this.referenceRateStoreIds);
  }

  async upsertConfig(clientId: number, input: UpdateBillingConfigInput): void {
    const existing = this.configs.find((row) => row.clientId === clientId);
    const next: BillingConfigRecord = {
      clientId,
      pickPackFee: input.pickPackFee ?? 3,
      additionalUnitFee: input.additionalUnitFee ?? 0.75,
      packageCostMarkup: existing?.packageCostMarkup ?? 0,
      shippingMarkupPct: input.shippingMarkupPct ?? 0,
      shippingMarkupFlat: input.shippingMarkupFlat ?? 0,
      billing_mode: input.billing_mode ?? "label_cost",
      storageFeePerCuFt: input.storageFeePerCuFt ?? 0,
      storageFeeMode: input.storageFeeMode ?? "cubicft",
      palletPricingPerMonth: input.palletPricingPerMonth ?? 0,
      palletCuFt: input.palletCuFt ?? 80,
    };
    if (existing) {
      Object.assign(existing, next);
    } else {
      this.configs.push(next);
    }
  }

  async generate(input: Required<Pick<GenerateBillingInput, "from" | "to">> & Pick<GenerateBillingInput, "clientId">): GenerateBillingResult {
    void input;
    return { ok: true, generated: 0, total: 0 };
  }

  async listSummary(query: BillingSummaryQuery): BillingSummaryRecord[] {
    const rows = clone(this.summary);
    if (!query.clientId) return rows;
    return rows.filter((row) => row.clientId === query.clientId);
  }

  async listDetails(query: Required<BillingDetailsQuery>): BillingDetailRecord[] {
    return clone(this.details).filter((row) =>
      row.shipDate >= query.from && row.shipDate <= query.to
    );
  }

  async listPackagePrices(clientId: number): BillingPackagePriceRecord[] {
    return clone(this.packagePrices[clientId] ?? []);
  }

  async getInvoice(clientId: number, from: string, to: string): BillingInvoiceRecord | null {
    const client = this.clients.find((entry) => entry.clientId === clientId);
    if (!client) return null;
    const summaryRows = await this.listSummary({ clientId, from, to });
    const summary = summaryRows[0] ?? {
      clientId,
      clientName: client.name,
      pickPackTotal: 0,
      additionalTotal: 0,
      packageTotal: 0,
      shippingTotal: 0,
      storageTotal: 0,
      orderCount: 0,
      grandTotal: 0,
    };
    const details = (await this.listDetails({ clientId, from, to })).map((row) => ({
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      shipDate: row.shipDate,
      baseQty: row.totalQty,
      addlQty: 0,
      pickpackAmt: row.pickpackTotal,
      additionalAmt: row.additionalTotal,
      shippingAmt: row.shippingTotal,
      storageAmt: 0,
      rowTotal: row.pickpackTotal + row.additionalTotal + row.packageTotal + row.shippingTotal,
      skus: row.itemSkus,
    }));
    return {
      clientId,
      clientName: client.name,
      from,
      to,
      summary,
      details,
    };
  }

  async savePackagePrices(input: { clientId: number; prices: SaveBillingPackagePriceInput[] | undefined }): void {
    if (!this.packagePrices[input.clientId]) this.packagePrices[input.clientId] = [];
    for (const price of input.prices ?? []) {
      const existing = this.packagePrices[input.clientId].find((entry) => entry.packageId === price.packageId);
      if (existing) {
        existing.price = Number(price.price) || 0;
        existing.is_custom = 1;
      } else {
        this.packagePrices[input.clientId].push({
          packageId: price.packageId,
          price: Number(price.price) || 0,
          is_custom: 1,
          name: `Package ${price.packageId}`,
          length: null,
          width: null,
          height: null,
        });
      }
    }
  }

  async setDefaultPackagePrice(packageId: number, price: number): SetDefaultBillingPackagePriceResult {
    let updated = 0;
    for (const client of this.clients.filter((entry) => ![3, 4].includes(entry.clientId))) {
      if (!this.packagePrices[client.clientId]) this.packagePrices[client.clientId] = [];
      const existing = this.packagePrices[client.clientId].find((entry) => entry.packageId === packageId);
      if (!existing) {
        this.packagePrices[client.clientId].push({
          packageId,
          price: Number(price) || 0,
          is_custom: 0,
          name: `Package ${packageId}`,
          length: null,
          width: null,
          height: null,
        });
        updated += 1;
        continue;
      }
      if (existing.is_custom === 0) {
        existing.price = Number(price) || 0;
        updated += 1;
      }
    }
    const eligible = this.clients.filter((entry) => ![3, 4].includes(entry.clientId)).length;
    return { ok: true, updated, skipped: eligible - updated };
  }

  async listOrdersMissingReferenceRatesForFetch(_storeIds: number[]): BillingFetchReferenceRateOrderRecord[] {
    return clone(this.fetchOrders);
  }

  async listOrdersMissingReferenceRatesForBackfill(_input: BackfillBillingReferenceRatesInput): BillingBackfillReferenceRateOrderRecord[] {
    return clone(this.backfillOrders);
  }

  async findCachedReferenceRateCandidates(weightOz: number, zip5: string): RateDto[] | null {
    return clone(this.cachedReferenceRates[`${weightOz}|${zip5}`] ?? null);
  }

  async saveBackfilledReferenceRates(orderId: number, refUspsRate: number | null, refUpsRate: number | null): void {
    this.backfilledReferenceRates.set(orderId, { refUspsRate, refUpsRate });
  }
}

class MemoryClientRepository implements ClientRepository {
  private readonly records: ClientRecord[];

  constructor(records: ClientRecord[]) {
    this.records = records;
  }

  async listActive(): ClientRecord[] {
    return this.records.filter((record) => record.active === 1).map(clone);
  }

  async create(input: { name: string; storeIds?: number[]; contactName?: string; email?: string; phone?: string }): number {
    const clientId = this.records.reduce((max, record) => Math.max(max, record.clientId), 0) + 1;
    this.records.push({
      clientId,
      name: input.name,
      storeIds: JSON.stringify(input.storeIds ?? []),
      contactName: input.contactName ?? "",
      email: input.email ?? "",
      phone: input.phone ?? "",
      active: 1,
      ss_api_key: null,
      ss_api_secret: null,
      ss_api_key_v2: null,
      rate_source_client_id: null,
    });
    return clientId;
  }

  async update(clientId: number, input: { name: string; storeIds?: number[]; contactName?: string; email?: string; phone?: string; ss_api_key?: string | null; ss_api_secret?: string | null; ss_api_key_v2?: string | null; rate_source_client_id?: number | null }): void {
    const record = this.records.find((entry) => entry.clientId === clientId);
    if (!record) return;
    record.name = input.name;
    record.storeIds = JSON.stringify(input.storeIds ?? []);
    record.contactName = input.contactName ?? "";
    record.email = input.email ?? "";
    record.phone = input.phone ?? "";
    record.ss_api_key = input.ss_api_key ?? null;
    record.ss_api_secret = input.ss_api_secret ?? null;
    record.ss_api_key_v2 = input.ss_api_key_v2 ?? null;
    record.rate_source_client_id = input.rate_source_client_id ?? null;
  }

  async softDelete(clientId: number): void {
    const record = this.records.find((entry) => entry.clientId === clientId);
    if (record) record.active = 0;
  }

  async syncFromStores(stores: Array<{ storeId: number; storeName: string }>): void {
    for (const store of stores) {
      const name = store.storeName?.trim();
      if (!name || store.storeId == null) continue;

      const existing = this.records.find((entry) => entry.name === name);
      if (!existing) {
        const clientId = this.records.reduce((max, record) => Math.max(max, record.clientId), 0) + 1;
        this.records.push({
          clientId,
          name,
          storeIds: JSON.stringify([store.storeId]),
          contactName: "",
          email: "",
          phone: "",
          active: 1,
          ss_api_key: null,
          ss_api_secret: null,
          ss_api_key_v2: null,
          rate_source_client_id: null,
        });
        continue;
      }

      const storeIds = JSON.parse(existing.storeIds ?? "[]") as number[];
      if (!storeIds.includes(store.storeId)) {
        existing.storeIds = JSON.stringify([...storeIds, store.storeId]);
      }
    }
  }
}

class MemoryInitRepository implements InitRepository {
  private readonly clients: ClientRecord[];
  private readonly seed: MemoryDataStoreSeed["init"];

  constructor(
    clients: ClientRecord[],
    seed: MemoryDataStoreSeed["init"],
  ) {
    this.clients = clients;
    this.seed = seed;
  }

  async listLocalClientStores(): InitStoreDto[] {
    if (this.seed?.localStores) return clone(this.seed.localStores);
    const stores: InitStoreDto[] = [];
    for (const client of this.clients.filter((entry) => entry.active === 1)) {
      for (const storeId of parseStoreIds(client.storeIds)) {
        stores.push({
          storeId,
          storeName: client.name,
          marketplaceId: null,
          marketplaceName: "Local Client",
          accountName: null,
          email: null,
          integrationUrl: null,
          active: true,
          companyName: "",
          phone: "",
          publicEmail: "",
          website: "",
          refreshDate: null,
          lastRefreshAttempt: null,
          createDate: null,
          modifyDate: null,
          autoRefresh: false,
          statusMappings: null,
          isLocal: true,
        });
      }
    }
    return stores;
  }

  async getCounts(): InitCountsDto {
    return clone(this.seed?.counts ?? { byStatus: [], byStatusStore: [] });
  }

  async getRateBrowserMarkups(): Record<string, unknown> {
    return clone(this.seed?.markups ?? {});
  }
}

class MemoryInventoryRepository implements InventoryRepository {
  private nextLedgerId = 1;
  private readonly records: InventoryRecord[];
  private readonly ledger: Array<Record<string, unknown>>;
  private readonly parents: ParentSkuDto[];
  private nextId: number;

  constructor(
    records: InventoryRecord[],
    ledger: Array<Record<string, unknown>>,
    parents: ParentSkuDto[],
    nextId: number,
  ) {
    this.records = records;
    this.ledger = ledger;
    this.parents = parents;
    this.nextId = nextId;
    this.nextLedgerId = this.ledger.reduce((max, entry) => Math.max(max, Number(entry.id ?? 0)), 0) + 1;
  }

  async list(query: ListInventoryQuery): InventoryRecord[] {
    return this.records.filter((record) => {
      if (query.clientId && record.clientId !== query.clientId) return false;
      if (query.sku && !record.sku.toLowerCase().includes(query.sku.toLowerCase())) return false;
      return true;
    }).map(clone);
  }

  async receive(input: ReceiveInventoryInput): ReceiveInventoryResultDto[] {
    const received: ReceiveInventoryResultDto[] = [];
    for (const item of input.items) {
      let record = this.records.find((entry) => entry.clientId === input.clientId && entry.sku === item.sku);
      if (!record) {
        record = {
          id: this.nextId,
          clientId: input.clientId,
          sku: item.sku,
          name: item.name ?? item.sku,
          minStock: 0,
          active: true,
          weightOz: 0,
          parentSkuId: null,
          baseUnitQty: 1,
          packageLength: 0,
          packageWidth: 0,
          packageHeight: 0,
          productLength: 0,
          productWidth: 0,
          productHeight: 0,
          packageId: null,
          unitsPerPack: 1,
          cuFtOverride: null,
          clientName: `Client ${input.clientId}`,
          packageName: null,
          packageDimLength: null,
          packageDimWidth: null,
          packageDimHeight: null,
          parentName: null,
          currentStock: 0,
          lastMovement: null,
          imageUrl: null,
        };
        this.records.push(record);
        this.nextId += 1;
      }
      record.currentStock += item.qty;
      record.lastMovement = Date.now();
      this.ledger.unshift({
        id: this.nextLedgerId++,
        invSkuId: record.id,
        type: "receive",
        qty: item.qty,
        orderId: null,
        note: input.note ?? null,
        createdBy: "memory",
        createdAt: Date.now(),
        sku: record.sku,
        skuName: record.name,
        clientId: record.clientId,
        clientName: record.clientName,
      });
      received.push({
        sku: record.sku,
        qty: item.qty,
        baseUnitQty: record.baseUnitQty,
        baseUnits: item.qty * record.baseUnitQty,
        invSkuId: record.id,
        newStock: record.currentStock,
      });
    }
    return received;
  }

  async adjust(input: AdjustInventoryInput): number {
    const record = this.records.find((entry) => entry.id === input.invSkuId);
    if (!record) return 0;
    record.currentStock += input.qty;
    record.lastMovement = Date.now();
    this.ledger.unshift({
      id: this.nextLedgerId++,
      invSkuId: record.id,
      type: input.type ?? "adjust",
      qty: input.qty,
      orderId: null,
      note: input.note ?? null,
      createdBy: "memory",
      createdAt: Date.now(),
      sku: record.sku,
      skuName: record.name,
      clientId: record.clientId,
      clientName: record.clientName,
    });
    return record.currentStock;
  }

  async update(inventoryId: number, input: UpdateInventoryItemInput): void {
    const record = this.records.find((entry) => entry.id === inventoryId);
    if (!record) return;
    Object.assign(record, {
      name: input.name ?? record.name,
      minStock: input.minStock ?? record.minStock,
      weightOz: input.weightOz ?? record.weightOz,
      packageLength: input.length ?? record.packageLength,
      packageWidth: input.width ?? record.packageWidth,
      packageHeight: input.height ?? record.packageHeight,
      productLength: input.productLength ?? record.productLength,
      productWidth: input.productWidth ?? record.productWidth,
      productHeight: input.productHeight ?? record.productHeight,
      packageId: input.packageId ?? record.packageId,
      unitsPerPack: input.units_per_pack ?? record.unitsPerPack,
      cuFtOverride: input.cuFtOverride ?? record.cuFtOverride,
    });
  }

  async listLedger(query: ListInventoryLedgerQuery): Record<string, unknown>[] {
    return this.ledger.filter((entry) => {
      if (query.clientId && Number(entry.clientId) !== query.clientId) return false;
      if (query.type && entry.type !== query.type) return false;
      if (query.dateStart && Number(entry.createdAt) < query.dateStart) return false;
      if (query.dateEnd && Number(entry.createdAt) > query.dateEnd) return false;
      return true;
    }).slice(0, query.limit).map(clone);
  }

  async getLedgerByInventoryId(inventoryId: number): Record<string, unknown>[] {
    return this.ledger.filter((entry) => Number(entry.invSkuId) === inventoryId).map(clone);
  }

  async listAlerts(clientId: number): InventoryAlertRecord[] {
    return this.records
      .filter((record) => record.clientId === clientId && record.currentStock <= record.minStock)
      .map((record) => ({
        type: "sku",
        id: record.id,
        sku: record.sku,
        name: record.name,
        stock: record.currentStock,
        minStock: record.minStock,
        parentSkuId: record.parentSkuId,
      }));
  }

  async populate(): { ok: true; skusRegistered: number; shippedProcessed: number } {
    return { ok: true, skusRegistered: 0, shippedProcessed: 0 };
  }

  async importProductDimensions(): { ok: true; updated: number; skipped: number; noMatch: number; total: number } {
    return { ok: true, updated: 0, skipped: this.records.length, noMatch: 0, total: this.records.length };
  }

  async bulkUpdateDimensions(input: BulkUpdateInventoryDimensionsInput): { ok: true; updated: number } {
    for (const change of input.updates) {
      const record = this.records.find((entry) => entry.id === change.invSkuId);
      if (!record) continue;
      if (change.weightOz != null) record.weightOz = Number(change.weightOz);
      if (change.productLength != null) record.productLength = Number(change.productLength);
      if (change.productWidth != null) record.productWidth = Number(change.productWidth);
      if (change.productHeight != null) record.productHeight = Number(change.productHeight);
    }
    return { ok: true, updated: input.updates.length };
  }

  async listParentSkus(clientId: number): ParentSkuDto[] {
    return this.parents.filter((entry) => entry.clientId === clientId).map((parent) => ({
      ...clone(parent),
      childCount: this.records.filter((record) => record.parentSkuId === parent.parentSkuId && record.active).length,
      totalBaseUnits: this.records
        .filter((record) => record.parentSkuId === parent.parentSkuId && record.active)
        .reduce((sum, record) => sum + record.currentStock, 0),
    }));
  }

  async getParentSku(parentSkuId: number): ParentSkuDetailDto | null {
    const parent = this.parents.find((entry) => entry.parentSkuId === parentSkuId);
    if (!parent) return null;
    const children = this.records
      .filter((record) => record.parentSkuId === parentSkuId)
      .map((record) => ({
        id: record.id,
        sku: record.sku,
        name: record.name,
        minStock: record.minStock,
        active: record.active,
        baseUnitQty: record.baseUnitQty,
        baseUnits: record.currentStock,
      }));
    const lowStockChildren = children.filter((child) => child.baseUnits <= child.minStock);
    return {
      ...clone(parent),
      children,
      totalBaseUnits: children.reduce((sum, child) => sum + child.baseUnits, 0),
      lowStockCount: lowStockChildren.length,
      lowStockChildren,
    };
  }

  async createParentSku(input: SaveParentSkuInput): { ok: true; parentSkuId: number; sku?: string; baseUnitQty: number } {
    const parentSkuId = this.parents.reduce((max, parent) => Math.max(max, parent.parentSkuId), 0) + 1;
    const baseUnitQty = Math.max(1, Number.parseInt(String(input.baseUnitQty ?? 1), 10) || 1);
    this.parents.push({
      parentSkuId,
      clientId: input.clientId,
      name: input.name,
      sku: input.sku ?? "",
      baseUnitQty,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { ok: true, parentSkuId, sku: input.sku ?? "", baseUnitQty };
  }

  async setParent(inventoryId: number, input: SetInventoryParentInput): { ok: true } {
    const record = this.records.find((entry) => entry.id === inventoryId);
    if (!record) return { ok: true };
    if (input.parentSkuId === null) {
      record.parentSkuId = null;
      record.baseUnitQty = 1;
      return { ok: true };
    }
    const parent = this.parents.find((entry) => entry.parentSkuId === input.parentSkuId);
    if (!parent) {
      throw new Error("Parent SKU not found");
    }
    record.parentSkuId = input.parentSkuId;
    record.baseUnitQty = Math.max(1, Number.parseInt(String(input.baseUnitQty ?? 1), 10) || 1);
    return { ok: true };
  }

  async deleteParent(parentSkuId: number): { ok: true } {
    const childCount = this.records.filter((record) => record.parentSkuId === parentSkuId).length;
    if (childCount > 0) {
      throw new Error(`Cannot delete parent with ${childCount} child SKU(s). Unlink children first.`);
    }
    const index = this.parents.findIndex((entry) => entry.parentSkuId === parentSkuId);
    if (index >= 0) this.parents.splice(index, 1);
    return { ok: true };
  }

  async getSkuOrders(inventoryId: number): Record<string, unknown> | null {
    const record = this.records.find((entry) => entry.id === inventoryId);
    if (!record) return null;
    return {
      sku: record.sku,
      name: record.name,
      clientId: record.clientId,
      totalUnits: 0,
      dailySales: [],
      orders: [],
    };
  }
}

class MemoryLocationRepository implements LocationRepository {
  private readonly records: LocationRecord[];

  constructor(records: LocationRecord[]) {
    this.records = records;
  }

  async list(): LocationRecord[] {
    return this.records.filter((record) => record.active === 1).map(clone);
  }

  async getDefault(): LocationRecord | null {
    const record = this.records.find((entry) => entry.active === 1 && entry.isDefault === 1);
    return record ? clone(record) : null;
  }

  async create(input: SaveLocationInput): number {
    const locationId = this.records.reduce((max, record) => Math.max(max, record.locationId), 0) + 1;
    this.records.push({
      locationId,
      name: input.name,
      company: input.company ?? "",
      street1: input.street1 ?? "",
      street2: input.street2 ?? "",
      city: input.city ?? "",
      state: input.state ?? "",
      postalCode: input.postalCode ?? "",
      country: input.country ?? "US",
      phone: input.phone ?? "",
      isDefault: input.isDefault ? 1 : 0,
      active: 1,
    });
    return locationId;
  }

  async update(locationId: number, input: SaveLocationInput): void {
    const record = this.records.find((entry) => entry.locationId === locationId);
    if (!record) return;
    record.name = input.name;
    record.company = input.company ?? "";
    record.street1 = input.street1 ?? "";
    record.street2 = input.street2 ?? "";
    record.city = input.city ?? "";
    record.state = input.state ?? "";
    record.postalCode = input.postalCode ?? "";
    record.country = input.country ?? "US";
    record.phone = input.phone ?? "";
    record.isDefault = input.isDefault ? 1 : 0;
  }

  async delete(locationId: number): void {
    const record = this.records.find((entry) => entry.locationId === locationId);
    if (record) record.active = 0;
  }

  async clearDefault(): void {
    for (const record of this.records) record.isDefault = 0;
  }

  async setDefault(locationId: number): void {
    const record = this.records.find((entry) => entry.locationId === locationId);
    if (record) record.isDefault = 1;
  }
}

class MemoryOrderRepository implements OrderRepository {
  private readonly entries: MemoryOrderEntry[];

  constructor(entries: MemoryOrderEntry[]) {
    this.entries = entries;
  }

  async list(query: ListOrdersQuery): OrderListResult {
    const filtered = this.filterOrders(query);
    const page = Math.max(1, query.page);
    const pageSize = Math.max(1, query.pageSize);
    const offset = (page - 1) * pageSize;
    return {
      orders: filtered.slice(offset, offset + pageSize).map((entry) => clone(entry.record)),
      total: filtered.length,
    };
  }

  async getById(orderId: number): OrderRecord | null {
    const entry = this.entries.find((item) => item.record.orderId === orderId);
    return entry ? clone(entry.record) : null;
  }

  async findIdsBySku(query: GetOrderIdsQuery): number[] {
    return this.filterOrders({ page: 1, pageSize: Number.MAX_SAFE_INTEGER, orderStatus: query.orderStatus, storeId: query.storeId })
      .filter((entry) => {
        const matches = entry.items.filter((item) => {
          const sku = String(item.sku ?? "").toLowerCase();
          const name = String(item.name ?? "").toLowerCase();
          return item.adjustment !== true && (sku === query.sku.toLowerCase() || name === query.sku.toLowerCase());
        });
        if (matches.length === 0) return false;
        if (query.qty == null) return true;
        const totalQty = matches.reduce((sum, item) => sum + Number(item.quantity ?? 1), 0);
        return totalQty === query.qty;
      })
      .map((entry) => entry.record.orderId);
  }

  async getPicklist(query: GetOrderPicklistQuery): OrderPicklistItemDto[] {
    const filtered = this.filterOrders({ page: 1, pageSize: Number.MAX_SAFE_INTEGER, orderStatus: query.orderStatus, storeId: query.storeId, dateStart: query.dateStart, dateEnd: query.dateEnd });
    const map = new Map<string, OrderPicklistItemDto>();
    for (const entry of filtered) {
      const seen = new Set<string>();
      for (const item of entry.items.filter((value) => value.adjustment !== true && Number(value.quantity ?? 1) > 0)) {
        const sku = String(item.sku ?? "");
        const key = sku || `_name_${String(item.name ?? "")}`;
        const current = map.get(key) ?? {
          storeId: entry.record.storeId,
          clientName: entry.clientName ?? "",
          sku,
          name: item.name ? String(item.name) : null,
          imageUrl: item.imageUrl ? String(item.imageUrl) : null,
          totalQty: 0,
          orderCount: 0,
        };
        current.totalQty += Number(item.quantity ?? 1);
        if (!seen.has(key)) {
          current.orderCount += 1;
          seen.add(key);
        }
        map.set(key, current);
      }
    }
    return Array.from(map.values()).sort((left, right) => right.totalQty - left.totalQty);
  }

  async getFullById(orderId: number): OrderFullDto | null {
    const entry = this.entries.find((item) => item.record.orderId === orderId);
    return entry?.full ? clone(entry.full) : null;
  }

  async updateExternalShipped(orderId: number, externalShipped: boolean): void {
    const entry = this.entries.find((item) => item.record.orderId === orderId);
    if (entry) entry.record.externalShipped = externalShipped;
  }

  async updateResidential(orderId: number, residential: boolean | null): void {
    const entry = this.entries.find((item) => item.record.orderId === orderId);
    if (entry) entry.record.residential = residential;
  }

  async updateSelectedPid(orderId: number, selectedPid: number | null): void {
    const entry = this.entries.find((item) => item.record.orderId === orderId);
    if (!entry) return;
    const selectedRate = entry.record.selectedRateJson ? JSON.parse(entry.record.selectedRateJson) as Record<string, unknown> : {};
    selectedRate.providerAccountId = selectedPid;
    selectedRate.shippingProviderId = selectedPid;
    entry.record.selectedRateJson = JSON.stringify(selectedRate);
  }

  async updateBestRate(orderId: number, bestRate: OrderBestRateDto): void {
    const entry = this.entries.find((item) => item.record.orderId === orderId);
    if (entry) entry.record.bestRateJson = JSON.stringify(bestRate);
  }

  async updateOrderRateDims(orderId: number, length: number, width: number, height: number): void {
    const entry = this.entries.find((item) => item.record.orderId === orderId);
    if (entry) {
      entry.record.rateDimsL = length;
      entry.record.rateDimsW = width;
      entry.record.rateDimsH = height;
    }
  }

  async getSkuQtyDims(_sku: string, _qty: number): { length: number; width: number; height: number } | null {
    return null; // In-memory store doesn't persist sku_qty_dims
  }

  async saveSkuQtyDims(_sku: string, _qty: number, _length: number, _width: number, _height: number): void {
    // In-memory store: no-op
  }

  async getDailyStats(): OrdersDailyStatsDto {
    return {
      window: {
        from: "2026-03-09T12:00:00",
        to: "2026-03-10T12:00:00",
        fromLabel: "Mar 9, 12pm PT",
        toLabel: "Mar 10, 12pm PT",
      },
      totalOrders: this.entries.length,
      needToShip: this.entries.filter((entry) => entry.record.orderStatus === "awaiting_shipment").length,
      upcomingOrders: 0,
    };
  }

  async exportOrders(_query: OrderExportQuery): OrderExportRow[] {
    // Memory store: return empty — only used in tests that don't exercise export
    return [];
  }

  private filterOrders(query: Partial<ListOrdersQuery>): MemoryOrderEntry[] {
    return this.entries
      .filter((entry) => {
        if (query.orderStatus && entry.record.orderStatus !== query.orderStatus) return false;
        if (query.storeId != null && entry.record.storeId !== query.storeId) return false;
        if (query.dateStart && (entry.record.orderDate ?? "") < query.dateStart) return false;
        if (query.dateEnd && (entry.record.orderDate ?? "") > query.dateEnd) return false;
        return true;
      })
      .sort((left, right) => (right.record.orderDate ?? "").localeCompare(left.record.orderDate ?? ""));
  }
}

class MemoryPackageRepository implements PackageRepository {
  private readonly records: PackageRecord[];
  private readonly ledger: Record<number, Array<Record<string, unknown>>>;
  private nextId: number;

  constructor(
    records: PackageRecord[],
    ledger: Record<number, Array<Record<string, unknown>>>,
    nextId: number,
  ) {
    this.records = records;
    this.ledger = ledger;
    this.nextId = nextId;
  }

  async list(source?: string): PackageRecord[] {
    return this.records.filter((record) => !source || record.source === source).map(clone);
  }

  async listLowStock(): PackageRecord[] {
    return this.records.filter((record) => (record.stockQty ?? 0) <= (record.reorderLevel ?? 0)).map(clone);
  }

  async findByDims(length: number, width: number, height: number): PackageRecord | null {
    const record = this.records.find((entry) => entry.length === length && entry.width === width && entry.height === height);
    return record ? clone(record) : null;
  }

  async getById(packageId: number): PackageRecord | null {
    const record = this.records.find((entry) => entry.packageId === packageId);
    return record ? clone(record) : null;
  }

  async create(input: SavePackageInput): number {
    const packageId = this.nextId++;
    this.records.push({
      packageId,
      name: input.name,
      type: input.type ?? "box",
      length: input.length ?? 0,
      width: input.width ?? 0,
      height: input.height ?? 0,
      tareWeightOz: input.tareWeightOz ?? 0,
      source: "memory",
      carrierCode: null,
      stockQty: 0,
      reorderLevel: input.reorderLevel ?? 0,
      unitCost: input.unitCost ?? null,
    });
    return packageId;
  }

  async update(packageId: number, input: SavePackageInput): void {
    const record = this.records.find((entry) => entry.packageId === packageId);
    if (!record) return;
    record.name = input.name;
    record.type = input.type ?? record.type;
    record.length = input.length ?? record.length;
    record.width = input.width ?? record.width;
    record.height = input.height ?? record.height;
    record.tareWeightOz = input.tareWeightOz ?? record.tareWeightOz;
    record.reorderLevel = input.reorderLevel ?? record.reorderLevel;
    record.unitCost = input.unitCost ?? record.unitCost;
  }

  async delete(packageId: number): void {
    const index = this.records.findIndex((entry) => entry.packageId === packageId);
    if (index >= 0) this.records.splice(index, 1);
  }

  async receive(packageId: number, input: PackageAdjustmentInput): PackageRecord | null {
    const record = this.records.find((entry) => entry.packageId === packageId);
    if (!record) return null;
    record.stockQty = (record.stockQty ?? 0) + input.qty;
    this.appendLedger(packageId, input.qty, "receive", input.note ?? null);
    return clone(record);
  }

  async adjust(packageId: number, input: PackageAdjustmentInput): PackageRecord | null {
    const record = this.records.find((entry) => entry.packageId === packageId);
    if (!record) return null;
    record.stockQty = (record.stockQty ?? 0) + input.qty;
    this.appendLedger(packageId, input.qty, "adjust", input.note ?? null);
    return clone(record);
  }

  async setReorderLevel(packageId: number, reorderLevel: number): void {
    const record = this.records.find((entry) => entry.packageId === packageId);
    if (record) record.reorderLevel = reorderLevel;
  }

  async getLedger(packageId: number): Record<string, unknown>[] {
    return clone(this.ledger[packageId] ?? []);
  }

  async autoCreate(input: AutoCreatePackageInput): { package: PackageRecord; isNew: boolean } {
    const existing = this.records.find((entry) => entry.length === input.length && entry.width === input.width && entry.height === input.height);
    if (existing) return { package: clone(existing), isNew: false };
    const packageId = await this.create({
      name: `${input.length}x${input.width}x${input.height}`,
      type: "box",
      length: input.length,
      width: input.width,
      height: input.height,
    });
    return { package: clone(this.records.find((entry) => entry.packageId === packageId) as PackageRecord), isNew: true };
  }

  async syncCarrierPackages(carrierCode: string, packages: Array<{ code: string; name: string; type?: string; length?: number; width?: number; height?: number; tareWeightOz?: number }>): void {
    for (const pkg of packages) {
      const existing = this.records.find((entry) => entry.source === "carrier" && entry.carrierCode === carrierCode && entry.name === pkg.name);
      if (existing) {
        existing.type = pkg.type ?? existing.type;
        existing.length = pkg.length ?? existing.length;
        existing.width = pkg.width ?? existing.width;
        existing.height = pkg.height ?? existing.height;
        existing.tareWeightOz = pkg.tareWeightOz ?? existing.tareWeightOz;
        continue;
      }
      this.records.push({
        packageId: this.nextId++,
        name: pkg.name,
        type: pkg.type ?? "box",
        length: pkg.length ?? 0,
        width: pkg.width ?? 0,
        height: pkg.height ?? 0,
        tareWeightOz: pkg.tareWeightOz ?? 0,
        source: "carrier",
        carrierCode,
        stockQty: 0,
        reorderLevel: 0,
        unitCost: null,
      });
    }
  }

  private appendLedger(packageId: number, qty: number, type: string, note: string | null) {
    if (!this.ledger[packageId]) this.ledger[packageId] = [];
    this.ledger[packageId].unshift({
      packageId,
      qty,
      type,
      note,
      createdAt: Date.now(),
    });
  }
}

class MemoryProductRepository implements ProductRepository {
  private readonly products: Record<string, ProductDefaultsRecord>;
  private readonly packages: PackageRecord[];

  constructor(products: Record<string, ProductDefaultsRecord>, packages: PackageRecord[]) {
    this.products = products;
    this.packages = packages;
  }

  async getBulk(skus: string[]) {
    const map: Record<string, ProductDefaultsRecord> = {};
    for (const sku of skus) {
      if (this.products[sku]) map[sku] = clone(this.products[sku]);
    }
    return map;
  }

  async getBySku(sku: string): ProductDefaultsRecord | null {
    return this.products[sku] ? clone(this.products[sku]) : null;
  }

  async saveDefaults(input: SaveProductDefaultsInput): SaveProductDefaultsRecordResult {
    const sku = input.sku ?? `product-${input.productId}`;
    const current = this.products[sku] ?? {
      sku,
      weightOz: 0,
      length: 0,
      width: 0,
      height: 0,
      defaultPackageCode: null,
      _localOnly: true,
    };

    let resolvedPackageId: number | null = null;
    let newPackageCreated = false;
    const length = Number(input.length ?? current.length ?? 0);
    const width = Number(input.width ?? current.width ?? 0);
    const height = Number(input.height ?? current.height ?? 0);
    let defaultPackageCode = input.packageCode ?? (input.packageId != null ? String(input.packageId) : current.defaultPackageCode ?? null);

    if (!defaultPackageCode && length > 0 && width > 0 && height > 0) {
      const existing = this.packages.find((entry) => entry.length === length && entry.width === width && entry.height === height);
      if (existing) {
        resolvedPackageId = existing.packageId;
      } else {
        resolvedPackageId = this.packages.reduce((max, entry) => Math.max(max, entry.packageId), 0) + 1;
        this.packages.push({
          packageId: resolvedPackageId,
          name: `${length}x${width}x${height}`,
          type: "box",
          length,
          width,
          height,
          tareWeightOz: 0,
          source: "custom",
          carrierCode: null,
          stockQty: 0,
          reorderLevel: 0,
          unitCost: null,
        });
        newPackageCreated = true;
      }
      defaultPackageCode = resolvedPackageId ? String(resolvedPackageId) : null;
    }

    this.products[sku] = {
      sku,
      weightOz: Number(input.weightOz ?? input.weight ?? current.weightOz ?? 0),
      length,
      width,
      height,
      defaultPackageCode,
      _localOnly: true,
    };

    const packageData = resolvedPackageId != null
      ? this.packages.find((entry) => entry.packageId === resolvedPackageId) ?? null
      : null;
    return {
      ok: true,
      localOnly: true,
      resolvedPackageId,
      newPackageCreated,
      packageData: packageData ? {
        packageId: packageData.packageId,
        name: packageData.name,
        length: packageData.length,
        width: packageData.width,
        height: packageData.height,
        source: packageData.source,
      } : null,
    };
  }
}

class MemoryRateRepository implements RateRepository {
  private readonly seed: MemoryDataStoreSeed["rates"];
  private readonly cache: Record<string, CachedRateRecord>;

  constructor(seed: MemoryDataStoreSeed["rates"]) {
    this.seed = seed;
    this.cache = clone(seed?.cache ?? {});
  }

  async getClientIdForStoreId(storeId: number): number | null {
    return this.seed?.storeClientMap?.[storeId] ?? null;
  }

  async getCurrentWeightVersion(): number {
    return this.seed?.weightVersion ?? 0;
  }

  async getCachedRate(cacheKey: string): CachedRateRecord | null {
    return clone(this.cache[cacheKey] ?? null);
  }

  async listCarriersForClient(clientId: number | null): CarrierAccountDto[] {
    const carriers = this.seed?.carriers ?? CARRIER_ACCOUNTS_V2;
    const carrierGroupClientId = clientId != null &&
      carriers.some((carrier) => carrier.clientId === clientId)
      ? clientId
      : null;

    return carriers.filter((carrier) =>
      !BLOCKED_CARRIER_IDS.has(carrier.shippingProviderId) &&
      carrier.clientId === carrierGroupClientId,
    ).map(clone);
  }

  async getRateSourceConfig(clientId: number | null): RateSourceConfig {
    return {
      apiKeyV2: clientId != null ? `memory-key-${clientId}` : "memory-main-key",
      sourceClientId: clientId,
    };
  }

  async clearCaches(): void {
    for (const key of Object.keys(this.cache)) {
      delete this.cache[key];
    }
  }

  async listOrdersForRateRefetch(limit: number): RefetchRateOrderRecord[] {
    return clone(this.seed?.refetchOrders ?? []).slice(0, limit);
  }

  async saveCachedRate(
    cacheKey: string,
    weightOz: number,
    toZip: string,
    rates: RateDto[],
    bestRate: RateDto | null,
    weightVersion: number,
  ): void {
    void weightOz;
    void toZip;
    this.cache[cacheKey] = {
      ratesJson: JSON.stringify(rates),
      bestRateJson: bestRate ? JSON.stringify(bestRate) : null,
      weightVersion,
    };
  }

  async saveReferenceRates(orderIds: number[], rates: RateDto[], weightOz: number, dims: RateDimsDto | null, storeId: number | null): void {
    void orderIds;
    void rates;
    void weightOz;
    void dims;
    void storeId;
  }
}

class MemoryManifestRepository implements ManifestRepository {
  private readonly shipments: ManifestShipmentRecord[];

  constructor(shipments: ManifestShipmentRecord[]) {
    this.shipments = shipments;
  }

  async listShipments() {
    return this.shipments.map(clone);
  }
}

class MemoryLabelRepository implements LabelRepository {
  private readonly orders: MemoryOrderEntry[];
  private readonly shipments: LabelShipmentRecord[];
  private lastSync: number | null = null;

  constructor(orders: MemoryOrderEntry[], shipments: LabelShipmentRecord[]) {
    this.orders = orders;
    this.shipments = shipments;
  }

  async getOrder(orderId: number): LabelOrderRecord | null {
    const match = this.orders.find((entry) => entry.record.orderId === orderId);
    if (!match) return null;
    return {
      orderId: match.record.orderId,
      orderNumber: match.record.orderNumber,
      orderStatus: match.record.orderStatus,
      storeId: match.record.storeId,
      clientId: match.record.clientId,
      weightValue: typeof match.record.raw === "object" ? null : null,
      shipToName: match.record.shipToName,
      raw: typeof match.record.raw === "string" ? match.record.raw : JSON.stringify(match.record.raw),
    };
  }

  async findActiveLabelForOrder(orderId: number): ExistingLabelRecord | null {
    const shipment = this.shipments.find((entry) => entry.orderId === orderId && !entry.voided);
    return shipment ? { shipmentId: shipment.shipmentId, trackingNumber: shipment.trackingNumber, labelUrl: shipment.labelUrl } : null;
  }

  async resolvePackageDimensions(_orderId: number): ResolvedPackageDimensions | null {
    return null;
  }

  async getShippingAccountContext(storeId: number | null): ShippingAccountContext {
    return { clientId: 1, storeId, v1ApiKey: null, v1ApiSecret: null, v2ApiKey: null, rateSourceClientId: null };
  }

  async saveShipment(input: PersistedShipmentInput): void {
    const existing = this.shipments.find((entry) => entry.shipmentId === input.shipmentId);
    const next: LabelShipmentRecord = {
      shipmentId: input.shipmentId,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      trackingNumber: input.trackingNumber,
      labelUrl: input.labelUrl,
      carrierCode: input.carrierCode,
      serviceCode: input.serviceCode,
      shipmentCost: input.shipmentCost,
      labelCreatedAt: input.labelCreatedAt,
      voided: input.voided,
      source: input.source,
      storeId: this.orders.find((entry) => entry.record.orderId === input.orderId)?.record.storeId ?? null,
    };
    if (existing) Object.assign(existing, next);
    else this.shipments.push(next);
  }

  async markOrderShipped(orderId: number): void {
    const order = this.orders.find((entry) => entry.record.orderId === orderId);
    if (order) order.record.orderStatus = "shipped";
  }

  async markShipmentVoided(shipmentId: number, orderId: number): void {
    const shipment = this.shipments.find((entry) => entry.shipmentId === shipmentId);
    if (shipment) shipment.voided = true;
    const order = this.orders.find((entry) => entry.record.orderId === orderId);
    if (order) order.record.orderStatus = "awaiting_shipment";
  }

  async saveReturnLabel(_record: ReturnLabelRecord): void {}

  async getShipmentForVoidOrReturn(shipmentId: number): LabelShipmentRecord | null {
    return clone(this.shipments.find((entry) => entry.shipmentId === shipmentId) ?? null);
  }

  async getLatestShipmentForOrderLookup(orderLookup: number | string): LabelShipmentRecord | null {
    const shipment = typeof orderLookup === "number"
      ? this.shipments.find((entry) => entry.orderId === orderLookup && !entry.voided)
      : this.shipments.find((entry) => entry.orderNumber === orderLookup && !entry.voided);
    return clone(shipment ?? null);
  }

  async updateShipmentLabelUrl(shipmentId: number, labelUrl: string): void {
    const shipment = this.shipments.find((entry) => entry.shipmentId === shipmentId);
    if (shipment) shipment.labelUrl = labelUrl;
  }

  async backfillOrderLocalTracking(_orderId: number, _trackingNumber: string, _providerAccountId: number | null, _updatedAtSeconds: number): void {}
  async enrichShipment(_input: import("../../modules/labels/domain/label.ts").ShipmentEnrichmentInput): void {}
  async saveMockLabelData(_shipmentId: number, _data: import("../../modules/labels/application/mock-label-generator.ts").MockLabelData): void {}
  async getMockLabelData(_shipmentId: number): import("../../modules/labels/application/mock-label-generator.ts").MockLabelData | null { return null; }
}

class MemoryShipmentRepository implements ShipmentRepository {
  private readonly orders: MemoryOrderEntry[];
  private readonly shipments: LabelShipmentRecord[];
  private lastSync: number | null = null;

  constructor(orders: MemoryOrderEntry[], shipments: LabelShipmentRecord[]) {
    this.orders = orders;
    this.shipments = shipments;
  }

  async countActiveShipments(): number {
    return this.shipments.filter((entry) => !entry.voided).length;
  }

  async getLastShipmentSync(): number | null {
    return this.lastSync;
  }

  async setLastShipmentSync(timestamp: number): void {
    this.lastSync = timestamp;
  }

  async listSyncAccounts(): ShipmentSyncAccountRecord[] {
    return [{ clientId: 1, accountName: "main", v1ApiKey: null, v1ApiSecret: null, v2ApiKey: null }];
  }

  async resolveOrderIdByOrderNumber(orderNumber: string): number | null {
    return this.orders.find((entry) => entry.record.orderNumber === orderNumber)?.record.orderId ?? null;
  }

  async orderExists(orderId: number): boolean {
    return this.orders.some((entry) => entry.record.orderId === orderId);
  }

  async getOrderClientId(orderId: number): number | null {
    return this.orders.find((entry) => entry.record.orderId === orderId)?.record.clientId ?? null;
  }

  async upsertShipmentBatch(shipments: ShipmentSyncRecord[]): void {
    for (const shipment of shipments) {
      const existing = this.shipments.find((entry) => entry.shipmentId === shipment.shipmentId);
      const next: LabelShipmentRecord = {
        shipmentId: shipment.shipmentId,
        orderId: shipment.orderId,
        orderNumber: shipment.orderNumber,
        trackingNumber: shipment.trackingNumber,
        labelUrl: existing?.labelUrl ?? null,
        carrierCode: shipment.carrierCode,
        serviceCode: shipment.serviceCode,
        shipmentCost: shipment.shipmentCost,
        labelCreatedAt: shipment.createDate ? Date.parse(shipment.createDate) : null,
        voided: shipment.voided,
        source: shipment.source,
        storeId: this.orders.find((entry) => entry.record.orderId === shipment.orderId)?.record.storeId ?? null,
      };
      if (existing) Object.assign(existing, next);
      else this.shipments.push(next);
    }
  }

  async backfillOrderLocalFromShipments(_shipments: ShipmentSyncRecord[]): void {}
}

class MemorySettingsRepository implements SettingsRepository {
  private readonly settings: Map<string, string>;

  constructor(settings: Map<string, string>) {
    this.settings = settings;
  }

  async get(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  async set(key: string, value: string): void {
    this.settings.set(key, value);
  }
}

class MemoryQueueRepository implements QueueRepository {
  private readonly entries: Map<string, PrintQueueEntry> = new Map();

  async add(input: AddToQueueInput): PrintQueueEntry {
    const now = Math.floor(Date.now() / 1000);
    // Check for existing by orderId+clientId
    for (const e of this.entries.values()) {
      if (e.orderId === input.orderId && e.clientId === input.clientId) {
        const updated: PrintQueueEntry = { ...e, labelUrl: input.labelUrl, status: 'queued', queuedAt: now };
        this.entries.set(e.id, updated);
        return updated;
      }
    }
    const entry: PrintQueueEntry = {
      id: randomUUID(),
      clientId: input.clientId,
      orderId: input.orderId,
      orderNumber: input.orderNumber ?? null,
      labelUrl: input.labelUrl,
      skuGroupId: input.skuGroupId,
      primarySku: input.primarySku ?? null,
      itemDescription: input.itemDescription ?? null,
      orderQty: input.orderQty ?? 1,
      multiSkuData: input.multiSkuData ?? null,
      status: 'queued',
      printCount: 0,
      lastPrintedAt: null,
      queuedAt: now,
      createdAt: now,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  async getByClient(clientId: number, status?: 'queued' | 'printed'): PrintQueueEntry[] {
    return [...this.entries.values()].filter(e => e.clientId === clientId && (!status || e.status === status));
  }

  async findById(id: string): PrintQueueEntry | null {
    return this.entries.get(id) ?? null;
  }

  async findByOrderId(orderId: string, clientId: number): PrintQueueEntry | null {
    for (const e of this.entries.values()) {
      if (e.orderId === orderId && e.clientId === clientId) return e;
    }
    return null;
  }

  async markPrinted(ids: string[], printedAt: number): void {
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) this.entries.set(id, { ...e, status: 'printed', printCount: e.printCount + 1, lastPrintedAt: printedAt });
    }
  }

  async remove(id: string): void {
    this.entries.delete(id);
  }

  async clearByClient(clientId: number): number {
    let count = 0;
    for (const [id, e] of this.entries.entries()) {
      if (e.clientId === clientId && e.status === 'queued') { this.entries.delete(id); count++; }
    }
    return count;
  }
}

export function createMemoryDataStore(seed: MemoryDataStoreSeed = {}): ApiDataStore {
  const clients = clone(seed.clients ?? []);
  const locations = clone(seed.locations ?? []);
  const manifests = clone(seed.manifests?.shipments ?? []);
  const labelShipments = clone(seed.labels?.shipments ?? []);
  const orders = clone(seed.orders ?? []);
  const packages = clone(seed.packages?.records ?? []);
  const packageLedger = clone(seed.packages?.ledger ?? {});
  const inventoryRecords = clone(seed.inventory?.records ?? []);
  const inventoryLedger = clone(seed.inventory?.ledger ?? []);
  const inventoryParents = clone(seed.inventory?.parents ?? []);
  const products = clone(seed.products?.bySku ?? {});
  const shipFromState: ShipFromState = new InMemoryShipFromState();

  return {
    queueRepository: new MemoryQueueRepository(),
    billingRepository: new MemoryBillingRepository(seed.billing),
    analysisRepository: new MemoryAnalysisRepository(seed.analysis),
    clientRepository: new MemoryClientRepository(clients),
    initRepository: new MemoryInitRepository(clients, seed.init),
    inventoryRepository: new MemoryInventoryRepository(inventoryRecords, inventoryLedger, inventoryParents, seed.inventory?.nextId ?? (inventoryRecords.reduce((max, record) => Math.max(max, record.id), 0) + 1)),
    labelRepository: new MemoryLabelRepository(orders, labelShipments),
    locationRepository: new MemoryLocationRepository(locations),
    manifestRepository: new MemoryManifestRepository(manifests),
    orderRepository: new MemoryOrderRepository(orders),
    packageRepository: new MemoryPackageRepository(packages, packageLedger, seed.packages?.nextId ?? (packages.reduce((max, record) => Math.max(max, record.packageId), 0) + 1)),
    productRepository: new MemoryProductRepository(products, packages),
    rateRepository: new MemoryRateRepository(seed.rates),
    settingsRepository: new MemorySettingsRepository(new Map(Object.entries(seed.settings ?? {}))),
    shipmentRepository: new MemoryShipmentRepository(orders, labelShipments),
    shipFromState,
  };
}
