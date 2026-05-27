export type ConnectorProvider =
  | 'shipstation'
  | 'walmart'
  | 'walmart_shipping'
  | 'shipp'
  | 'easypost'
  | 'ups'
  | 'fedex'
  | 'ebay'
  | 'shopify'
  | 'amazon'
  | 'tiktok_shop'
  | 'woocommerce';

export type ConnectorCapability =
  | 'orders.import'
  | 'orders.statusSync'
  | 'shipment.confirm'
  | 'rates.quote'
  | 'labels.create'
  | 'labels.void'
  | 'tracking.read'
  | 'returns.create'
  | 'returns.sync'
  | 'inventory.import'
  | 'inventory.push'
  | 'products.import'
  | 'products.images'
  | 'products.dimensions'
  | 'credentials.verify'
  | 'credentials.refresh'
  | 'credentials.oauth'
  | 'webhooks.receive';

export type NormalizedOrderStatus = 'awaiting_shipment' | 'shipped' | 'cancelled' | 'on_hold';

export type NormalizedOrder = {
  sourceProvider: ConnectorProvider;
  sourceAccountId: string;
  sourceOrderId: string;
  sourceOrderNumber: string | null;
  marketplace: string | null;
  storeId: string | null;
  canonicalStatus: NormalizedOrderStatus;
  orderDate?: Date | null;
  customerName: string | null;
  customerEmail?: string | null;
  shipToCity?: string | null;
  shipToState?: string | null;
  shipToPostalCode?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  weightOz?: number | null;
  orderTotal?: string | null;
  shippingPaid: number | null;
  items?: unknown[];
  externallyShipped?: boolean;
  rawPayload: unknown;
};

export type StoreOrderImportInput = {
  companyId: number;
  accountId: string;
  cursor?: string | null;
  orderStatus?: string;
  sinceMs?: number;
  pageSize?: number;
  page?: number;
  storeId?: number;
  credentials?: Record<string, string | null | undefined>;
  dedupeKey?: string;
  createdStartDate?: string;
  sinceDate?: string;
  limit?: number;
};

export type StoreOrderStatusSyncInput = {
  companyId: number;
  accountId: string;
};

export type StoreOrderFetchInput = {
  companyId: number;
  accountId: string;
  sourceOrderId: string;
};

export type NormalizedStoreOrderImportResult = {
  provider: ConnectorProvider;
  accountId: string;
  orders: NormalizedOrder[];
  cursor?: string | null;
  page?: number;
  pages?: number;
  total?: number;
  diagnostics?: Record<string, unknown>;
};

export type NormalizedStoreOrderStatusSyncResult = {
  provider: ConnectorProvider;
  accountId: string;
  updated: number;
  diagnostics?: Record<string, unknown>;
};

export type CarrierRateInput = Record<string, unknown>;
export type CarrierLabelInput = Record<string, unknown>;
export type NormalizedRate = Record<string, unknown>;
export type NormalizedLabel = Record<string, unknown>;
export type CarrierVoidInput = { labelId: string; trackingNumber?: string | null };
export type CarrierTrackingInput = { trackingNumber: string; carrierCode?: string | null };
export type NormalizedCarrierRateQuoteResult = {
  provider: ConnectorProvider;
  rates: NormalizedRate[];
  diagnostics?: Record<string, unknown>;
};
export type NormalizedCarrierLabelResult = NormalizedLabel & {
  provider?: ConnectorProvider;
  trackingNumber?: string | null;
  labelUrl?: string | null;
  labelBase64?: string | null;
  labelFormat?: string | null;
  cost?: number | null;
  currency?: string | null;
  diagnostics?: Record<string, unknown>;
};
export type NormalizedCarrierVoidResult = {
  provider: ConnectorProvider;
  voided: boolean;
  diagnostics?: Record<string, unknown>;
};
export type NormalizedDimensions = { length: number | null; width: number | null; height: number | null; unit: string };
export type NormalizedInventoryItem = Record<string, unknown>;
export type NormalizedProduct = Record<string, unknown>;
export type InventoryStockUpdate = Record<string, unknown>;
export type ReturnLabelInput = Record<string, unknown>;
export type NormalizedReturnLabel = Record<string, unknown>;
export type NormalizedReturn = Record<string, unknown>;
export type StoreConnectorAccountInput = Record<string, unknown>;

export type NormalizedTrackingStatus = {
  trackingNumber: string;
  status: 'unknown' | 'pre_transit' | 'in_transit' | 'delivered' | 'exception' | 'return_to_sender';
  rawPayload?: unknown;
};

export type MarketplaceShipmentConfirmationInput = {
  orderId: number;
  shipmentId: number;
  externalOrderId: string | null;
  clientId: number | null;
  orderNumber: string | null;
  trackingNumber: string;
  carrierCode: string | null;
  shipDate: string;
  notifyCustomer?: boolean;
  notifyMarketplace?: boolean;
  credentials?: Record<string, string | null | undefined>;
  payload?: Record<string, unknown>;
};

export type MarketplaceShipmentConfirmationResult = {
  ok: boolean;
  provider: ConnectorProvider;
  retryable?: boolean;
  message?: string;
  raw?: unknown;
};

export type ShipmentConfirmationInput = MarketplaceShipmentConfirmationInput;
export type ConfirmationResult = MarketplaceShipmentConfirmationResult;

export type NormalizedConnectorEvent = {
  provider: ConnectorProvider;
  accountId: string | null;
  eventType: string;
  sourceEventId: string | null;
  payload: unknown;
};

export interface StoreConnector {
  provider: ConnectorProvider;
  capabilities: ConnectorCapability[];
  importOrders?(input: StoreOrderImportInput): Promise<NormalizedOrder[] | NormalizedStoreOrderImportResult>;
  syncOrderStatuses?(input: StoreOrderStatusSyncInput): Promise<void | NormalizedStoreOrderStatusSyncResult>;
  normalizeOrder?(raw: unknown): NormalizedOrder;
  confirmShipment(input: ShipmentConfirmationInput): Promise<ConfirmationResult>;
  cancelOrder?(input: { companyId: number; accountId: string; sourceOrderId: string }): Promise<void>;
  fetchOrder?(input: StoreOrderFetchInput): Promise<NormalizedOrder | null>;
}

export interface CarrierConnector<
  RateInput = CarrierRateInput,
  RateResult = NormalizedRate,
  LabelInput = CarrierLabelInput,
  LabelResult = NormalizedCarrierLabelResult,
> {
  provider: ConnectorProvider;
  capabilities: ConnectorCapability[];
  getRates(input: RateInput): Promise<RateResult[]>;
  createLabel(input: LabelInput): Promise<LabelResult>;
  voidLabel?(input: CarrierVoidInput): Promise<void | NormalizedCarrierVoidResult>;
  trackShipment?(input: CarrierTrackingInput): Promise<NormalizedTrackingStatus>;
}

export interface MarketplaceConfirmationConnector {
  provider: ConnectorProvider;
  capabilities: ConnectorCapability[];
  confirmShipment(input: MarketplaceShipmentConfirmationInput): Promise<MarketplaceShipmentConfirmationResult>;
  retryConfirmation(input: { outboxId: number }): Promise<MarketplaceShipmentConfirmationResult>;
  normalizeConfirmationError(error: unknown): { code: string; message: string; retryable: boolean };
}

export interface InventoryConnector {
  provider: ConnectorProvider;
  capabilities: ConnectorCapability[];
  importProducts(input: { companyId: number; accountId: string }): Promise<NormalizedInventoryItem[]>;
  syncStockLevels(input: { companyId: number; accountId: string }): Promise<void>;
  pushStockUpdates(input: InventoryStockUpdate[]): Promise<void>;
  normalizeSku(raw: unknown): string;
  normalizeProduct(raw: unknown): NormalizedInventoryItem;
}

export interface ProductCatalogConnector {
  provider: ConnectorProvider;
  capabilities: ConnectorCapability[];
  importProducts(input: { companyId: number; accountId: string }): Promise<NormalizedProduct[]>;
  normalizeProduct(raw: unknown): NormalizedProduct;
  mapMarketplaceSkuToInternalSku(input: { marketplaceSku: string; accountId: string }): Promise<string | null>;
  fetchImages?(input: { sourceProductId: string; accountId: string }): Promise<string[]>;
  fetchDimensions?(input: { sourceProductId: string; accountId: string }): Promise<NormalizedDimensions | null>;
}

export interface TrackingConnector {
  provider: ConnectorProvider;
  capabilities: ConnectorCapability[];
  trackShipment(input: { trackingNumber: string; carrierCode?: string | null }): Promise<NormalizedTrackingStatus>;
  normalizeTrackingStatus(raw: unknown): NormalizedTrackingStatus;
  detectDelivered(status: NormalizedTrackingStatus): boolean;
  detectException(status: NormalizedTrackingStatus): boolean;
  detectReturnToSender(status: NormalizedTrackingStatus): boolean;
}

export interface ReturnConnector {
  provider: ConnectorProvider;
  capabilities: ConnectorCapability[];
  createReturnLabel(input: ReturnLabelInput): Promise<NormalizedReturnLabel>;
  syncReturns(input: { companyId: number; accountId: string; cursor?: string | null }): Promise<NormalizedReturn[]>;
  receiveReturnStatus(input: { sourceReturnId: string; accountId: string }): Promise<NormalizedReturn>;
  confirmReturnReceived(input: { sourceReturnId: string; accountId: string }): Promise<void>;
}

export interface CredentialAuthConnector {
  provider: ConnectorProvider;
  capabilities: ConnectorCapability[];
  verifyCredentials(input: { companyId: number; accountId: string }): Promise<{ ok: boolean; message?: string }>;
  refreshToken?(input: { companyId: number; accountId: string }): Promise<void>;
  storeAccount(input: StoreConnectorAccountInput): Promise<void>;
  mapAccountToClient(input: { companyId: number; accountId: string; clientId: number }): Promise<void>;
  handleOAuthCallback?(input: { companyId: number; code: string; state: string }): Promise<void>;
}

export interface WebhookConnector {
  provider: ConnectorProvider;
  capabilities: ConnectorCapability[];
  verifySignature(input: { headers: Record<string, string>; body: string }): Promise<boolean>;
  parseWebhook(input: { headers: Record<string, string>; body: string }): Promise<unknown>;
  normalizeEvent(raw: unknown): NormalizedConnectorEvent;
  enqueueSyncJob(event: NormalizedConnectorEvent): Promise<void>;
}
