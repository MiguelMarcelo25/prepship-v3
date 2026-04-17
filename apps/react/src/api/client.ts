/**
 * API Client Wrapper - Typed fetch wrapper for PrepShip V2 endpoints
 * Handles authentication, error handling, and response typing
 */

import type {
  ListOrdersQuery,
  ListOrdersResponse,
  OrderFullDto,
  ClientDto,
  CreateClientInput,
  CarrierAccountDto,
  InitCountsDto,
  InitStoreDto,
  InventoryItemDto,
  InventoryLedgerEntryDto,
  InventoryAlertDto,
  BulkUpdateInventoryDimensionsInput,
  LocationDto,
  ShipmentSyncStatusDto,
  LegacySyncStatusDto,
  ProductDefaultsDto,
  ReceiveInventoryInput,
  ReceiveInventoryResultDto,
  AdjustInventoryInput,
  UpdateInventoryItemInput,
  SaveParentSkuInput,
  SetInventoryParentInput,
  SaveLocationInput,
  UpdateClientInput,
  SaveProductDefaultsInput,
  SaveProductDefaultsResult,
  ParentSkuDetailDto,
  ParentSkuDto,
  ListInventoryQuery,
  ListInventoryLedgerQuery,
  PackageDto,
  PackageLedgerEntryDto,
  PackageMutationResult,
  OrdersDailyStatsDto,
  OrderPicklistResponseDto,
  CreateClientResult,
  CreateLabelRequestDto,
  CreateLabelResponseDto,
  CreateParentSkuResult,
  InventoryBulkUpdateDimsResult,
  InventoryImportDimsResult,
  InventoryPopulateResult,
  InventorySkuOrdersDto,
  LocationMutationResult,
  OkResult,
  RetrieveLabelResponseDto,
  ReturnLabelResponseDto,
  SetDefaultLocationResult,
  SyncClientsResult,
  VoidLabelResponseDto,
  PrintQueueResponseDto,
  QueueAddResponseDto,
  QueueClearResponseDto,
  QueuePrintJobDto,
  QueuePrintJobStatusDto,
  ColumnPrefsDto,
  ClearAndRefetchResultDto,
  SavePackageInput,
  PackageAdjustmentInput,
  BillingConfigDto,
  UpdateBillingConfigInput,
  BillingSummaryDto,
  BillingDetailDto,
  GenerateBillingResult,
  BillingPackagePriceDto,
  SaveBillingPackagePricesInput,
  SetDefaultBillingPackagePriceResult,
  FetchBillingReferenceRatesResult,
  BillingReferenceRateFetchStatusDto,
  BackfillBillingReferenceRatesInput,
  BackfillBillingReferenceRatesResult,
} from "../types/api";
import type {
  AnalysisDailySalesQuery,
  AnalysisDailySalesResponse,
  AnalysisSkuQuery,
  AnalysisSkusResponse,
} from "@prepshipv2/contracts/analysis/contracts";
import type { GenerateManifestInput } from "@prepshipv2/contracts/manifests/contracts";
import type { LiveRatesRequestDto, RateDto } from "@prepshipv2/contracts/rates/contracts";

/**
 * API Error class
 */
export class ApiError extends Error {
  status: number;
  statusText: string;

  constructor(
    status: number,
    statusText: string,
    message?: string
  ) {
    super(message || `API Error: ${status} ${statusText}`);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
  }
}

/**
 * API Client configuration and methods
 */
class ApiClient {
  private baseUrl: string;
  private appToken: string | null = null;

  constructor(baseUrl: string = "/api") {
    this.baseUrl = baseUrl;
    this.loadToken();
  }

  /**
   * Load app token from localStorage
   */
  private loadToken() {
    if (typeof window !== "undefined") {
      this.appToken = localStorage.getItem("app-token");
    }
  }

  /**
   * Set app token
   */
  setToken(token: string) {
    this.appToken = token;
    if (typeof window !== "undefined") {
      localStorage.setItem("app-token", token);
    }
  }

  /**
   * Clear app token
   */
  clearToken() {
    this.appToken = null;
    if (typeof window !== "undefined") {
      localStorage.removeItem("app-token");
    }
  }

  /**
   * Build headers with authentication
   */
  private buildHeaders(customHeaders: Record<string, string> = {}): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...customHeaders,
    };

    if (this.appToken) {
      headers["X-App-Token"] = this.appToken;
    }

    return headers;
  }

  private async parseErrorMessage(response: Response): Promise<string> {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = JSON.parse(text) as { error?: string };
        if (typeof body.error === "string" && body.error.trim()) {
          return body.error;
        }
      } catch {
        // Fall through to raw text below.
      }
    }

    return text;
  }

  private getDownloadFilename(contentDisposition: string | null, fallback: string): string {
    if (!contentDisposition) return fallback;

    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ""));
    }

    const simpleMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    if (simpleMatch?.[1]) {
      return simpleMatch[1].trim();
    }

    return fallback;
  }

  /**
   * Make authenticated fetch request
   */
  private async request<T>(
    endpoint: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
    } = {}
  ): Promise<T> {
    const { method = "GET", query, body, headers: customHeaders } = options;

    let url = `${this.baseUrl}${endpoint}`;

    // Append query parameters
    if (query) {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          params.append(key, String(value));
        }
      });
      const queryString = params.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const fetchOptions: RequestInit = {
      method,
      headers: this.buildHeaders(customHeaders),
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(
        response.status,
        response.statusText,
        text || `HTTP ${response.status}`
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * GET /orders
   */
  async fetchOrders(query: ListOrdersQuery): Promise<ListOrdersResponse> {
    return this.request<ListOrdersResponse>("/orders", {
      method: "GET",
      query: {
        page: query.page,
        pageSize: query.pageSize,
        orderStatus: query.orderStatus,
        storeId: query.storeId,
        clientId: query.clientId,
        dateStart: query.dateStart,
        dateEnd: query.dateEnd,
      },
    });
  }

  async listOrders(query: ListOrdersQuery): Promise<ListOrdersResponse> {
    return this.fetchOrders(query);
  }

  /**
   * GET /orders/:id
   */
  async fetchOrderDetail(orderId: number): Promise<unknown> {
    return this.request(`/orders/${orderId}`, { method: "GET" });
  }

  /**
   * GET /orders/:id/full
   */
  async fetchOrderFull(orderId: number): Promise<OrderFullDto> {
    return this.request<OrderFullDto>(`/orders/${orderId}/full`, { method: "GET" });
  }

  /**
   * PUT /orders/:id
   */
  async updateOrder(
    orderId: number,
    data: Record<string, unknown>
  ): Promise<unknown> {
    return this.request(`/orders/${orderId}`, {
      method: "PUT",
      body: data,
    });
  }

  /**
   * GET /clients
   */
  async fetchClients(): Promise<ClientDto[]> {
    return this.request<ClientDto[]>("/clients", { method: "GET" });
  }

  async listClients(): Promise<ClientDto[]> {
    return this.fetchClients();
  }

  /**
   * GET /counts
   */
  async fetchCounts(): Promise<InitCountsDto> {
    return this.request<InitCountsDto>("/counts", { method: "GET" });
  }

  /**
   * GET /stores
   */
  async fetchStores(): Promise<InitStoreDto[]> {
    return this.request<InitStoreDto[]>("/stores", { method: "GET" });
  }

  /**
   * GET /clients/:id
   */
  async fetchClientDetail(clientId: number): Promise<ClientDto> {
    return this.request<ClientDto>(`/clients/${clientId}`, { method: "GET" });
  }

  /**
   * POST /clients
   */
  async createClient(data: Record<string, unknown>): Promise<ClientDto> {
    return this.request<ClientDto>("/clients", {
      method: "POST",
      body: data,
    });
  }

  async createClientRecord(data: CreateClientInput): Promise<CreateClientResult> {
    return this.request<CreateClientResult>("/clients", {
      method: "POST",
      body: data,
    });
  }

  /**
   * PUT /clients/:id
   */
  async updateClient(
    clientId: number,
    data: UpdateClientInput
  ): Promise<ClientDto> {
    return this.request<ClientDto>(`/clients/${clientId}`, {
      method: "PUT",
      body: data,
    });
  }

  async updateClientRecord(
    clientId: number,
    data: UpdateClientInput
  ): Promise<OkResult> {
    return this.request<OkResult>(`/clients/${clientId}`, {
      method: "PUT",
      body: data,
    });
  }

  async deleteClientRecord(clientId: number): Promise<OkResult> {
    return this.request<OkResult>(`/clients/${clientId}`, {
      method: "DELETE",
    });
  }

  async syncClientsFromStores(): Promise<SyncClientsResult> {
    return this.request<SyncClientsResult>("/clients/sync-stores", {
      method: "POST",
    });
  }

  /**
   * GET /inventory
   */
  async fetchInventory(query?: ListInventoryQuery): Promise<InventoryItemDto[]> {
    const queryParams: Record<string, unknown> = {};
    if (query) {
      if (query.clientId !== undefined) queryParams.clientId = query.clientId;
      if (query.sku !== undefined) queryParams.sku = query.sku;
    }
    return this.request<InventoryItemDto[]>("/inventory", {
      method: "GET",
      query: queryParams,
    });
  }

  /**
   * GET /inventory/:id
   */
  async fetchInventoryDetail(invSkuId: number): Promise<InventoryItemDto> {
    return this.request<InventoryItemDto>(`/inventory/${invSkuId}`, {
      method: "GET",
    });
  }

  /**
   * PUT /inventory/:id
   */
  async updateInventoryItem(
    invSkuId: number,
    data: UpdateInventoryItemInput
  ): Promise<InventoryItemDto> {
    return this.request<InventoryItemDto>(`/inventory/${invSkuId}`, {
      method: "PUT",
      body: data,
    });
  }

  /**
   * GET /inventory/alerts
   */
  async fetchInventoryAlerts(): Promise<InventoryAlertDto[]> {
    return this.request<InventoryAlertDto[]>("/inventory/alerts", {
      method: "GET",
    });
  }

  async fetchInventoryItemLedger(invSkuId: number): Promise<InventoryLedgerEntryDto[]> {
    return this.request<InventoryLedgerEntryDto[]>(`/inventory/${invSkuId}/ledger`, {
      method: "GET",
    });
  }

  /**
   * GET /inventory/ledger
   */
  async fetchInventoryLedger(
    query: ListInventoryLedgerQuery
  ): Promise<InventoryLedgerEntryDto[]> {
    const queryParams: Record<string, unknown> = {
      limit: query.limit,
    };
    if (query.clientId !== undefined) queryParams.clientId = query.clientId;
    if (query.type !== undefined) queryParams.type = query.type;
    if (query.dateStart !== undefined) queryParams.dateStart = query.dateStart;
    if (query.dateEnd !== undefined) queryParams.dateEnd = query.dateEnd;
    
    return this.request<InventoryLedgerEntryDto[]>("/inventory/ledger", {
      method: "GET",
      query: queryParams,
    });
  }

  /**
   * POST /inventory/receive
   */
  async receiveInventory(
    data: ReceiveInventoryInput
  ): Promise<ReceiveInventoryResultDto[]> {
    return this.request<ReceiveInventoryResultDto[]>("/inventory/receive", {
      method: "POST",
      body: data,
    });
  }

  /**
   * POST /inventory/adjust
   */
  async adjustInventory(data: AdjustInventoryInput): Promise<InventoryItemDto> {
    return this.request<InventoryItemDto>("/inventory/adjust", {
      method: "POST",
      body: data,
    });
  }

  async submitInventoryReceive(
    data: ReceiveInventoryInput
  ): Promise<{ ok: true; received: ReceiveInventoryResultDto[] }> {
    return this.request<{ ok: true; received: ReceiveInventoryResultDto[] }>("/inventory/receive", {
      method: "POST",
      body: data,
    });
  }

  async submitInventoryAdjustment(
    data: AdjustInventoryInput
  ): Promise<{ ok: boolean; newStock: number }> {
    return this.request<{ ok: boolean; newStock: number }>("/inventory/adjust", {
      method: "POST",
      body: data,
    });
  }

  async populateInventory(): Promise<InventoryPopulateResult> {
    return this.request<InventoryPopulateResult>("/inventory/populate", {
      method: "POST",
    });
  }

  async importInventoryDimensions(clientId?: number): Promise<InventoryImportDimsResult> {
    return this.request<InventoryImportDimsResult>("/inventory/import-dims", {
      method: "POST",
      query: clientId ? { clientId } : undefined,
    });
  }

  async bulkUpdateInventoryDimensions(
    data: BulkUpdateInventoryDimensionsInput
  ): Promise<InventoryBulkUpdateDimsResult> {
    return this.request<InventoryBulkUpdateDimsResult>("/inventory/bulk-update-dims", {
      method: "POST",
      body: data,
    });
  }

  async listParentSkus(clientId: number): Promise<ParentSkuDto[]> {
    return this.request<ParentSkuDto[]>("/parent-skus", {
      method: "GET",
      query: { clientId },
    });
  }

  async createParentSku(data: SaveParentSkuInput): Promise<CreateParentSkuResult> {
    return this.request<CreateParentSkuResult>("/parent-skus", {
      method: "POST",
      body: data,
    });
  }

  async setInventoryParent(invSkuId: number, data: SetInventoryParentInput): Promise<OkResult> {
    return this.request<OkResult>(`/inventory/${invSkuId}/set-parent`, {
      method: "PUT",
      body: data,
    });
  }

  async fetchInventorySkuOrders(invSkuId: number, days?: number): Promise<InventorySkuOrdersDto> {
    return this.request<InventorySkuOrdersDto>(`/inventory/${invSkuId}/sku-orders`, {
      method: "GET",
      query: days ? { days } : undefined,
    });
  }

  /**
   * GET /inventory/parent/:id
   */
  async fetchParentSkuDetail(parentSkuId: number): Promise<ParentSkuDetailDto> {
    return this.request<ParentSkuDetailDto>(`/inventory/parent/${parentSkuId}`, {
      method: "GET",
    });
  }

  /**
   * GET /locations
   */
  async fetchLocations(): Promise<LocationDto[]> {
    return this.request<LocationDto[]>("/locations", { method: "GET" });
  }

  /**
   * GET /carrier-accounts
   */
  async fetchCarrierAccounts(): Promise<CarrierAccountDto[]> {
    return this.request<CarrierAccountDto[]>("/carrier-accounts", { method: "GET" });
  }

  /**
   * GET /locations/:id
   */
  async fetchLocationDetail(locationId: number): Promise<LocationDto> {
    return this.request<LocationDto>(`/locations/${locationId}`, {
      method: "GET",
    });
  }

  /**
   * POST /locations
   */
  async createLocationMutation(data: SaveLocationInput): Promise<LocationMutationResult> {
    return this.request<LocationMutationResult>("/locations", {
      method: "POST",
      body: data,
    });
  }

  async createLocation(data: SaveLocationInput): Promise<LocationDto> {
    const result = await this.createLocationMutation(data);
    if (typeof result.locationId !== "number") {
      throw new Error("Location creation did not return a locationId");
    }

    const locations = await this.fetchLocations();
    const created = locations.find((location) => location.locationId === result.locationId);
    if (!created) {
      throw new Error(`Created location ${result.locationId} was not returned by /locations`);
    }

    return created;
  }

  /**
   * PUT /locations/:id
   */
  async updateLocationMutation(
    locationId: number,
    data: SaveLocationInput
  ): Promise<OkResult> {
    return this.request<OkResult>(`/locations/${locationId}`, {
      method: "PUT",
      body: data,
    });
  }

  async updateLocation(
    locationId: number,
    data: SaveLocationInput
  ): Promise<LocationDto> {
    await this.updateLocationMutation(locationId, data);
    const locations = await this.fetchLocations();
    const updated = locations.find((location) => location.locationId === locationId);
    if (!updated) {
      throw new Error(`Updated location ${locationId} was not returned by /locations`);
    }

    return updated;
  }

  /**
   * DELETE /locations/:id
   */
  async deleteLocationMutation(locationId: number): Promise<OkResult> {
    return this.request<OkResult>(`/locations/${locationId}`, { method: "DELETE" });
  }

  async deleteLocation(locationId: number): Promise<void> {
    await this.deleteLocationMutation(locationId);
  }

  /**
   * POST /locations/:id/setDefault
   */
  async setDefaultLocation(locationId: number): Promise<SetDefaultLocationResult> {
    return this.request<SetDefaultLocationResult>(`/locations/${locationId}/setDefault`, {
      method: "POST",
    });
  }

  /**
   * GET /shipments/sync-status
   */
  async fetchShipmentSyncStatus(): Promise<ShipmentSyncStatusDto> {
    return this.request<ShipmentSyncStatusDto>("/shipments/status", {
      method: "GET",
    });
  }

  /**
   * POST /shipments/sync
   */
  async triggerShipmentSync(): Promise<{ queued: boolean }> {
    return this.request<{ queued: boolean }>("/shipments/sync", {
      method: "POST",
    });
  }

  /**
   * GET /legacy-sync-status
   */
  async fetchLegacySyncStatus(): Promise<LegacySyncStatusDto> {
    return this.request<LegacySyncStatusDto>("/sync/status", {
      method: "GET",
    });
  }

  /**
   * POST /legacy-sync
   */
  async triggerLegacySync(mode?: "incremental" | "full"): Promise<{ queued: boolean }> {
    return this.request<{ queued: boolean }>("/sync/trigger", {
      method: "POST",
      body: mode === "full" ? { full: true } : undefined,
    });
  }

  async fetchColumnPrefs(): Promise<ColumnPrefsDto | null> {
    return this.request<ColumnPrefsDto | null>("/settings/colPrefs", { method: "GET" });
  }

  async saveColumnPrefs(data: ColumnPrefsDto): Promise<ColumnPrefsDto> {
    return this.request<ColumnPrefsDto>("/settings/colPrefs", {
      method: "PUT",
      body: data,
    });
  }

  async clearAndRefetchAllRates(): Promise<ClearAndRefetchResultDto> {
    return this.request<ClearAndRefetchResultDto>("/cache/clear-and-refetch", {
      method: "POST",
      body: { scope: "all" },
    });
  }

  async fetchPackages(source?: string): Promise<PackageDto[]> {
    return this.request<PackageDto[]>("/packages", {
      method: "GET",
      query: source ? { source } : undefined,
    });
  }

  async fetchLowStockPackages(): Promise<PackageDto[]> {
    return this.request<PackageDto[]>("/packages/low-stock", {
      method: "GET",
    });
  }

  async createPackageMutation(data: SavePackageInput): Promise<PackageMutationResult> {
    return this.request<PackageMutationResult>("/packages", {
      method: "POST",
      body: data,
    });
  }

  async updatePackageMutation(packageId: number, data: SavePackageInput): Promise<PackageMutationResult> {
    return this.request<PackageMutationResult>(`/packages/${packageId}`, {
      method: "PUT",
      body: data,
    });
  }

  async deletePackageMutation(packageId: number): Promise<OkResult> {
    return this.request<OkResult>(`/packages/${packageId}`, {
      method: "DELETE",
    });
  }

  async setPackageReorderLevel(packageId: number, reorderLevel: number): Promise<OkResult> {
    return this.request<OkResult>(`/packages/${packageId}/reorder-level`, {
      method: "PATCH",
      body: { reorderLevel },
    });
  }

  async receivePackage(packageId: number, data: PackageAdjustmentInput): Promise<PackageMutationResult> {
    return this.request<PackageMutationResult>(`/packages/${packageId}/receive`, {
      method: "POST",
      body: data,
    });
  }

  async adjustPackage(packageId: number, data: PackageAdjustmentInput): Promise<PackageMutationResult> {
    return this.request<PackageMutationResult>(`/packages/${packageId}/adjust`, {
      method: "POST",
      body: data,
    });
  }

  async fetchPackageLedger(packageId: number): Promise<PackageLedgerEntryDto[]> {
    return this.request<PackageLedgerEntryDto[]>(`/packages/${packageId}/ledger`, {
      method: "GET",
    });
  }

  async syncCarrierPackages(): Promise<{ queued: boolean }> {
    return this.request<{ queued: boolean }>("/packages/sync", {
      method: "POST",
    });
  }

  async setDefaultPackagePrice(packageId: number, price: number): Promise<SetDefaultBillingPackagePriceResult> {
    return this.request<SetDefaultBillingPackagePriceResult>("/billing/package-prices/set-default", {
      method: "POST",
      body: { packageId, price },
    });
  }

  async fetchBillingConfigs(): Promise<BillingConfigDto[]> {
    return this.request<BillingConfigDto[]>("/billing/config", {
      method: "GET",
    });
  }

  async updateBillingConfig(clientId: number, data: UpdateBillingConfigInput): Promise<OkResult> {
    return this.request<OkResult>(`/billing/config/${clientId}`, {
      method: "PUT",
      body: data,
    });
  }

  async generateBilling(from: string, to: string, clientId?: number): Promise<GenerateBillingResult> {
    return this.request<GenerateBillingResult>("/billing/generate", {
      method: "POST",
      body: {
        from,
        to,
        ...(clientId != null ? { clientId } : {}),
      },
    });
  }

  async fetchBillingSummary(from: string, to: string, clientId?: number): Promise<BillingSummaryDto[]> {
    return this.request<BillingSummaryDto[]>("/billing/summary", {
      method: "GET",
      query: {
        from,
        to,
        ...(clientId != null ? { clientId } : {}),
      },
    });
  }

  async fetchBillingDetails(from: string, to: string, clientId: number): Promise<BillingDetailDto[]> {
    return this.request<BillingDetailDto[]>("/billing/details", {
      method: "GET",
      query: {
        from,
        to,
        clientId,
      },
    });
  }

  async fetchBillingPackagePrices(clientId: number): Promise<BillingPackagePriceDto[]> {
    return this.request<BillingPackagePriceDto[]>("/billing/package-prices", {
      method: "GET",
      query: { clientId },
    });
  }

  async saveBillingPackagePrices(data: SaveBillingPackagePricesInput): Promise<OkResult> {
    return this.request<OkResult>("/billing/package-prices", {
      method: "PUT",
      body: data,
    });
  }

  async fetchBillingReferenceRates(): Promise<FetchBillingReferenceRatesResult> {
    return this.request<FetchBillingReferenceRatesResult>("/billing/fetch-ref-rates", {
      method: "POST",
    });
  }

  async fetchBillingReferenceRateStatus(): Promise<BillingReferenceRateFetchStatusDto> {
    return this.request<BillingReferenceRateFetchStatusDto>("/billing/fetch-ref-rates/status", {
      method: "GET",
    });
  }

  async backfillBillingReferenceRates(data: BackfillBillingReferenceRatesInput): Promise<BackfillBillingReferenceRatesResult> {
    return this.request<BackfillBillingReferenceRatesResult>("/billing/backfill-ref-rates", {
      method: "POST",
      body: data,
    });
  }

  async fetchProductsBySku(sku: string): Promise<ProductDefaultsDto | null> {
    try {
      return await this.request<ProductDefaultsDto>(`/products/by-sku/${encodeURIComponent(sku)}`, {
        method: "GET",
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async saveProductDefaultsV2(data: SaveProductDefaultsInput): Promise<SaveProductDefaultsResult> {
    return this.request<SaveProductDefaultsResult>("/products/save-defaults", {
      method: "POST",
      body: data,
    });
  }

  async fetchCarriersForStore(storeId?: number | null): Promise<{ carriers: CarrierAccountDto[] }> {
    return this.request<{ carriers: CarrierAccountDto[] }>("/carriers-for-store", {
      method: "GET",
      query: storeId != null ? { storeId } : undefined,
    });
  }

  async browseRates(data: Record<string, unknown>): Promise<{ rates: unknown[] }> {
    return this.request<{ rates: unknown[] }>("/rates/browse", {
      method: "POST",
      body: data,
    });
  }

  async fetchRates(data: LiveRatesRequestDto): Promise<RateDto[]> {
    return this.request<RateDto[]>("/rates", {
      method: "POST",
      body: data,
    });
  }

  async fetchAnalysisSkus(query: AnalysisSkuQuery): Promise<AnalysisSkusResponse> {
    return this.request<AnalysisSkusResponse>("/analysis/skus", {
      method: "GET",
      query: {
        from: query.from,
        to: query.to,
        clientId: query.clientId,
      },
    });
  }

  async fetchAnalysisDailySales(query: Partial<AnalysisDailySalesQuery>): Promise<AnalysisDailySalesResponse> {
    return this.request<AnalysisDailySalesResponse>("/analysis/daily-sales", {
      method: "GET",
      query: {
        from: query.from,
        to: query.to,
        clientId: query.clientId,
        top: query.top,
      },
    });
  }

  async downloadManifest(data: GenerateManifestInput): Promise<{ blob: Blob; filename: string }> {
    const response = await fetch(`${this.baseUrl}/manifests/generate`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new ApiError(
        response.status,
        response.statusText,
        await this.parseErrorMessage(response),
      );
    }

    const fallbackFilename = `manifest_${data.startDate}_${data.endDate}.csv`;
    return {
      blob: await response.blob(),
      filename: this.getDownloadFilename(response.headers.get("content-disposition"), fallbackFilename),
    };
  }

  async fetchDailyStats(): Promise<OrdersDailyStatsDto> {
    return this.request<OrdersDailyStatsDto>("/orders/daily-stats", {
      method: "GET",
    });
  }

  async fetchPicklist(query: {
    orderStatus?: string;
    storeId?: number;
    dateStart?: string;
    dateEnd?: string;
  }): Promise<OrderPicklistResponseDto> {
    return this.request<OrderPicklistResponseDto>("/orders/picklist", {
      method: "GET",
      query,
    });
  }

  async markOrderShippedExternal(orderId: number, source: string): Promise<unknown> {
    return this.request(`/orders/${orderId}/shipped-external`, {
      method: "POST",
      body: { flag: 1, source },
    });
  }

  async setOrderResidential(orderId: number, residential: boolean | null): Promise<unknown> {
    return this.request(`/orders/${orderId}/residential`, {
      method: "POST",
      body: { residential },
    });
  }

  async setOrderSelectedPid(orderId: number, selectedPid: number | null): Promise<unknown> {
    return this.request(`/orders/${orderId}/selected-pid`, {
      method: "POST",
      body: { selectedPid },
    });
  }

  async setOrderSelectedPackageId(orderId: number, packageId: number | null): Promise<unknown> {
    return this.request(`/orders/${orderId}/selected-package-id`, {
      method: "POST",
      body: { packageId },
    });
  }

  async saveOrderBestRate(orderId: number, best: unknown, dims?: string | null): Promise<unknown> {
    return this.request(`/orders/${orderId}/best-rate`, {
      method: "POST",
      body: { best, dims: dims ?? null },
    });
  }

  async fetchOrderDims(orderId: number): Promise<{ orderId: number; sku: string | null; qty: number | null; dims: { length: number; width: number; height: number } | null }> {
    return this.request(`/orders/${orderId}/dims`, { method: "GET" });
  }

  async createLabel(data: CreateLabelRequestDto): Promise<CreateLabelResponseDto> {
    return this.request<CreateLabelResponseDto>("/labels/create", {
      method: "POST",
      body: data,
    });
  }

  async retrieveLabel(orderLookup: number | string, fresh = false): Promise<RetrieveLabelResponseDto> {
    return this.request<RetrieveLabelResponseDto>(`/labels/${encodeURIComponent(String(orderLookup))}/retrieve`, {
      method: "GET",
      query: fresh ? { fresh: true } : undefined,
    });
  }

  async voidLabel(shipmentId: number): Promise<VoidLabelResponseDto> {
    return this.request<VoidLabelResponseDto>(`/labels/${shipmentId}/void`, {
      method: "POST",
      body: {},
    });
  }

  async createReturnLabel(shipmentId: number, reason = "Customer Return"): Promise<ReturnLabelResponseDto> {
    return this.request<ReturnLabelResponseDto>(`/labels/${shipmentId}/return`, {
      method: "POST",
      body: { reason },
    });
  }

  async fetchQueue(clientId: number, includePrinted = false): Promise<PrintQueueResponseDto> {
    return this.request<PrintQueueResponseDto>("/queue", {
      method: "GET",
      query: includePrinted ? { client_id: clientId, include_printed: 1 } : { client_id: clientId },
    });
  }

  async addToQueue(data: Record<string, unknown>): Promise<QueueAddResponseDto> {
    return this.request<QueueAddResponseDto>("/queue/add", {
      method: "POST",
      body: data,
    });
  }

  async clearQueue(clientId: number): Promise<QueueClearResponseDto> {
    return this.request<QueueClearResponseDto>("/queue/clear", {
      method: "POST",
      body: { client_id: clientId },
    });
  }

  async removeFromQueue(entryId: string, clientId: number): Promise<{ ok: true; removed_entry: string }> {
    return this.request<{ ok: true; removed_entry: string }>(`/queue/${entryId}`, {
      method: "DELETE",
      body: { client_id: clientId },
    });
  }

  async startQueuePrintJob(clientId: number, entryIds: string[], mergeHeaders = true): Promise<QueuePrintJobDto> {
    return this.request<QueuePrintJobDto>("/queue/print", {
      method: "POST",
      body: {
        client_id: clientId,
        queue_entry_ids: entryIds,
        merge_headers: mergeHeaders,
      },
    });
  }

  async fetchQueuePrintJobStatus(jobId: string): Promise<QueuePrintJobStatusDto> {
    return this.request<QueuePrintJobStatusDto>(`/queue/print/status/${jobId}`, {
      method: "GET",
    });
  }

  /**
   * GET /products
   */
  async fetchProducts(query?: { clientId?: number }): Promise<ProductDefaultsDto[]> {
    return this.request<ProductDefaultsDto[]>("/products", {
      method: "GET",
      query,
    });
  }

  /**
   * POST /products
   */
  async saveProductDefaults(
    data: SaveProductDefaultsInput
  ): Promise<SaveProductDefaultsResult> {
    return this.request<SaveProductDefaultsResult>("/products", {
      method: "POST",
      body: data,
    });
  }
}

/**
 * Singleton instance
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL
  ? `${import.meta.env.VITE_API_BASE_URL}/api`
  : "/api";
export const apiClient = new ApiClient(API_BASE);

/**
 * Export for testing/overrides
 */
export default apiClient;
