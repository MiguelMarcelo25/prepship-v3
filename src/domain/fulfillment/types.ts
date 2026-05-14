export type FulfillmentProvider = string;

export type ConfirmationStatus = 'not_required' | 'pending' | 'processing' | 'succeeded' | 'failed';

export type ConfirmationResult = {
  ok: boolean;
  provider: FulfillmentProvider;
  retryable?: boolean;
  message?: string;
  raw?: unknown;
};

export type ShipmentConfirmationInput = {
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

export interface StoreConnector {
  provider: FulfillmentProvider;
  confirmShipment(input: ShipmentConfirmationInput): Promise<ConfirmationResult>;
}

export interface CarrierConnector<LabelInput = unknown, LabelResult = unknown> {
  provider: FulfillmentProvider;
  getRates?(input: unknown): Promise<unknown[]>;
  createLabel(input: LabelInput): Promise<LabelResult>;
  voidLabel?(input: unknown): Promise<unknown>;
  trackShipment?(trackingNumber: string): Promise<unknown>;
}
