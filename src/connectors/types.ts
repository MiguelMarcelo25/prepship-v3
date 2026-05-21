export type ConnectorProvider =
  | 'shipstation'
  | 'walmart'
  | 'walmart_shipping'
  | 'shipp'
  | 'easypost'
  | 'ups'
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
  customerName: string | null;
  shippingPaid: number | null;
  rawPayload: unknown;
};

export type CarrierRateInput = Record<string, unknown>;
export type CarrierLabelInput = Record<string, unknown>;
export type NormalizedRate = Record<string, unknown>;
export type NormalizedLabel = Record<string, unknown>;
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
  sourceProvider: ConnectorProvider;
  sourceAccountId: string | null;
  sourceOrderId: string | null;
  trackingNumber: string;
  carrierCode: string | null;
  shipDate: string;
  payload?: Record<string, unknown>;
};

export type MarketplaceShipmentConfirmationResult = {
  ok: boolean;
  provider: ConnectorProvider;
  retryable?: boolean;
  message?: string;
  raw?: unknown;
};

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
  importOrders(input: { companyId: number; accountId: string; cursor?: string | null }): Promise<NormalizedOrder[]>;
  syncOrderStatuses(input: { companyId: number; accountId: string }): Promise<void>;
  normalizeOrder(raw: unknown): NormalizedOrder;
  confirmShipment(input: MarketplaceShipmentConfirmationInput): Promise<MarketplaceShipmentConfirmationResult>;
  cancelOrder?(input: { companyId: number; accountId: string; sourceOrderId: string }): Promise<void>;
  fetchOrder?(input: { companyId: number; accountId: string; sourceOrderId: string }): Promise<NormalizedOrder | null>;
}

export interface CarrierConnector {
  provider: ConnectorProvider;
  capabilities: ConnectorCapability[];
  getRates(input: CarrierRateInput): Promise<NormalizedRate[]>;
  createLabel(input: CarrierLabelInput): Promise<NormalizedLabel>;
  voidLabel?(input: { labelId: string; trackingNumber?: string | null }): Promise<void>;
  trackShipment?(input: { trackingNumber: string }): Promise<NormalizedTrackingStatus>;
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
